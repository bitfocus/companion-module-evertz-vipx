import { InstanceBase, TCPHelper, runEntrypoint, InstanceStatus } from '@companion-module/base'
import UpgradeScripts from './upgrades.js'
import { getVariables } from './variables.js'
import { getFeedbacks } from './feedbacks.js'
import { getActions } from './actions.js'

class EvertzVIPXInstance extends InstanceBase {
  constructor(internal) {
    super(internal)

    // protocol/connection state
    this._connected = false
    this._handshook = false
    this._ifaceVersion = undefined

    // caches for dynamic choices
    this._displays = []
    this._layouts = []
    this._windows = {} // displayId -> [{id,name}]
    this._inputs = {} // displayId -> [{id,name}]
    this._snapshots = []

    // json-rpc plumbing
    this._nextId = 1
    this._pending = new Map()
    this._rxBuffer = ''
    this._outboundQueue = [] // queue RPCs until handshake completes

    // debug toggle
    this._wireDebug = true
  }

  getConfigFields() {
    return [
      { type: 'textinput', id: 'host', label: 'VIP-X Host/IP', width: 6, default: '127.0.0.1' },
      { type: 'number', id: 'port', label: 'TCP Port', width: 3, default: 31001, min: 1, max: 65535 },
    ]
  }

  async init(config) {
    this.config = config
    this.updateStatus(InstanceStatus.Connecting)

    this.setVariableDefinitions(getVariables())
    this.setFeedbackDefinitions(getFeedbacks(this))
    this._setInitialVariables()

    this.initTCP()
    this._rebuildActions()
  }

  async configUpdated(config) {
    this.config = config
    this.initTCP()
  }

  async destroy() {
    if (this.socket) {
      this.socket.destroy()
      this.socket = undefined
    }
  }

  _setInitialVariables() {
    this.setVariableValues({
      connected: 'false',
      handshake_version: '',
      last_snapshot_loaded: '',
    })
  }

  initTCP() {
    this._handshook = false
    this._outboundQueue = []

    if (this.socket) {
      this.socket.destroy()
      this.socket = undefined
    }

    this.socket = new TCPHelper(this.config.host, this.config.port)

    this.socket.on('status_change', (status, message) => {
      this.log('debug', `Status: ${status} ${message ?? ''}`)

      if (status === 'connected' || status === 'ok') {
        this._connected = true
        // Stay "Connecting" until handshake completes, then set Ok
        if (!this._handshook) {
          this.updateStatus(InstanceStatus.Connecting)
          this.setVariableValues({ connected: 'true' })
          this._startHandshakeIfNeeded('status_change')
        }
        return
      }

      if (status === 'disconnected') {
        this._connected = false
        this._handshook = false
        this._outboundQueue = []
        this.updateStatus(InstanceStatus.Disconnected)
        this.setVariableValues({ connected: 'false', handshake_version: '' })
      } else if (status === 'connecting') {
        this.updateStatus(InstanceStatus.Connecting)
      }

      this.checkFeedbacks('connected')
    })

    this.socket.on('data', (chunk) => this._onData(chunk))
    this.socket.on('error', (err) => this.log('error', String(err)))
  }

  // ---------------- JSON-RPC helpers ----------------

  _sendRaw(obj) {
    const payload = JSON.stringify(obj) + '\r\n'
    if (this._wireDebug) this.log('debug', `→ ${payload.trimEnd()}`)
    this.socket?.send(payload)
  }

  async rpc(method, params = undefined) {
    // Gate all non-handshake RPCs until handshake completes
    if (!this._handshook && method !== 'handshake') {
      return new Promise((resolve, reject) => {
        this._outboundQueue.push({ method, params, resolve, reject })
        // Best effort: if we somehow haven't started handshake yet, kick it off
        this._startHandshakeIfNeeded('rpc_gate')
      })
    }

    const id = this._nextId++
    const req = { jsonrpc: '2.0', id, method }
    if (params !== undefined) req.params = params

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method })
      this._sendRaw(req)

      const t = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id)
          reject(new Error(`RPC timeout: ${method}`))
        }
      }, 7000)

      this._pending.get(id).timer = t
    })
  }

  _startHandshakeIfNeeded(origin) {
    if (this._handshook) return
    if (!this._connected) return
    // Avoid multiple concurrent calls
    if (this._startingHandshake) return
    this._startingHandshake = true

    this.handshake()
      .catch((e) => {
        this.log('error', `Handshake failed (${origin}): ${e && e.message ? e.message : e}`)
        this.updateStatus(InstanceStatus.ConnectionFailure, e?.message || 'Handshake failed')
      })
      .finally(() => {
        this._startingHandshake = false
      })
  }

  async handshake() {
    // Must be the FIRST client message after TCP open (spec)
    const res = await this.rpc('handshake', { client_supported_versions: [1, 2] })

    const negotiated =
      res?.result?.server_selected_version ??
      res?.server_selected_version ??
      1

    this._ifaceVersion = negotiated
    this._handshook = true

    this.setVariableValues({ handshake_version: String(negotiated) })
    this.log('info', `Handshake OK. Using interface version ${negotiated}`)

    // Now we're officially connected
    this.updateStatus(InstanceStatus.Ok)

    // Flush any queued RPCs (preserving order)
    const queue = this._outboundQueue
    this._outboundQueue = []
    for (const item of queue) {
      this.rpc(item.method, item.params).then(item.resolve).catch(item.reject)
    }

    // Prime lists
    await this.refreshAll().catch((e) => this.log('error', `Initial refresh failed: ${e && e.message ? e.message : e}`))
  }

  async refreshAll() {
    try {
      const [displays, layouts, snaps] = await Promise.all([
        this.rpc('get_displays'),
        this.rpc('get_layouts'),
        this.rpc('get_snapshots'),
      ])

      this._displays = (displays.result?.displays ?? displays.displays) || []
      this._layouts = (layouts.result?.layouts ?? layouts.layouts) || []
      this._snapshots = (snaps.result?.snapshots ?? snaps.snapshots) || []

      for (const d of this._displays) {
        const wid = await this.rpc('get_windows', { display: { id: d.id } }).catch(() => ({}))
        const iid = await this.rpc('get_display_inputs', { display: { id: d.id } }).catch(() => ({}))
        this._windows[d.id] = (wid.result?.windows ?? wid.windows) || []
        this._inputs[d.id] = (iid.result?.inputs ?? iid.inputs) || []
      }

      this._rebuildActions()
      this.checkFeedbacks()
      this.log('debug', `Refreshed lists — displays=${this._displays.length}, layouts=${this._layouts.length}, snapshots=${this._snapshots.length}`)
    } catch (e) {
      this.log('error', `Refresh error: ${e && e.message ? e.message : e}`)
      throw e
    }
  }

  _onData(chunk) {
    // If we get data before we fired handshake (some stacks do this), kick off handshake
    if (!this._handshook) this._startHandshakeIfNeeded('first_data')

    this._rxBuffer += chunk.toString('utf8')

    let idx
    while ((idx = this._rxBuffer.indexOf('\r\n')) >= 0) {
      const line = this._rxBuffer.slice(0, idx)
      this._rxBuffer = this._rxBuffer.slice(idx + 2)
      if (!line.trim()) continue

      if (this._wireDebug) this.log('debug', `← ${line}`)

      let msg
      try {
        msg = JSON.parse(line)
      } catch (e) {
        this.log('error', `JSON parse error: ${e} | data="${line}"`)
        continue
      }

      // Server can send requests (ping, notifications)
      if (msg.method) {
        this._handleServerRequest(msg)
        continue
      }

      // Responses
      if (typeof msg.id !== 'undefined') {
        const pending = this._pending.get(msg.id)
        if (pending) {
          this._pending.delete(msg.id)
          clearTimeout(pending.timer)
          if (msg.error) {
            pending.reject(new Error(`${pending.method} -> ${msg.error.message || 'error'}`))
          } else {
            pending.resolve(msg) // resolve with FULL response object
          }
        }
      }
    }
  }

  _handleServerRequest(req) {
    // VIP-X sends ping periodically; ignore until AFTER handshake, then reply with pong
    if (req.method === 'ping' && typeof req.id !== 'undefined') {
      if (!this._handshook) return
      this._sendRaw({ jsonrpc: '2.0', id: req.id, result: 'pong' })
      return
    }

    // Notifications keep our caches in sync
    switch (req.method) {
      case 'notify_create_snapshot':
      case 'notify_modify_snapshot':
      case 'notify_delete_snapshot': {
        const snap = req.params?.snapshot
        if (snap) {
          if (req.method === 'notify_delete_snapshot') {
            this._snapshots = this._snapshots.filter((s) => s.id !== snap.id)
          } else {
            const i = this._snapshots.findIndex((s) => s.id === snap.id)
            if (i >= 0) this._snapshots[i] = snap
            else this._snapshots.push(snap)
          }
          this._rebuildActions()
        }
        break
      }

      case 'notify_create_layout':
      case 'notify_modify_layout':
      case 'notify_delete_layout': {
        const layout = req.params?.layout
        if (layout) {
          if (req.method === 'notify_delete_layout') {
            this._layouts = this._layouts.filter((l) => l.id !== layout.id)
          } else {
            const i = this._layouts.findIndex((l) => l.id === layout.id)
            if (i >= 0) this._layouts[i] = layout
            else this._layouts.push(layout)
          }
          this._rebuildActions()
        }
        break
      }

      case 'notify_create_display':
      case 'notify_modify_display':
      case 'notify_delete_display': {
        const display = req.params?.display
        if (display) {
          if (req.method === 'notify_delete_display') {
            this._displays = this._displays.filter((d) => d.id !== display.id)
            delete this._windows[display.id]
            delete this._inputs[display.id]
          } else {
            const i = this._displays.findIndex((d) => d.id === display.id)
            if (i >= 0) this._displays[i] = display
            else this._displays.push(display)
            // lazily refresh child lists
            this.rpc('get_windows', { display: { id: display.id } })
              .then((w) => (this._windows[display.id] = w.result?.windows ?? w.windows ?? []))
              .catch(() => {})
            this.rpc('get_display_inputs', { display: { id: display.id } })
              .then((i2) => (this._inputs[display.id] = i2.result?.inputs ?? i2.inputs ?? []))
              .catch(() => {})
          }
          this._rebuildActions()
        }
        break
      }

      default:
        break
    }
  }

  _rebuildActions() {
    this.setActionDefinitions(getActions(this))
  }
}

runEntrypoint(EvertzVIPXInstance, UpgradeScripts)
