import { Regex } from '@companion-module/base'

export function getActions(instance) {
  const idChoiceFrom = (arr, labelKey = 'name') =>
    arr.map((x) => ({ id: x.id, label: `${x.id} — ${x[labelKey] ?? ''}` }))

  const nameChoiceFrom = (arr, labelKey = 'name') =>
    arr.map((x) => ({ id: x.name, label: `${x.name} (${x.id})` }))

  return {
    refresh: {
      name: 'Refresh Lists (Displays/Layouts/Windows/Inputs/Snapshots)',
      options: [],
      callback: async () => {
        await instance.refreshAll()
      },
    },

    // --- Snapshots ---
    fire_snapshot_by_id: {
      name: 'Fire Snapshot (by ID)',
      options: [
        {
          type: 'dropdown',
          id: 'snapshot_id',
          label: 'Snapshot',
          default: instance._snapshots?.[0]?.id ?? 0,
          choices: idChoiceFrom(instance._snapshots),
        },
      ],
      callback: async (event) => {
        const sid = Number(event.options.snapshot_id)
        await instance.rpc('load_snapshot', { snapshot: { id: sid } })
        instance.setVariableValues({
          last_snapshot_loaded: `id:${sid}`,
        })
      },
    },

    fire_snapshot_by_name: {
      name: 'Fire Snapshot (by Name)',
      options: [
        {
          type: 'dropdown',
          id: 'snapshot_name',
          label: 'Snapshot',
          default: instance._snapshots?.[0]?.name ?? '',
          choices: nameChoiceFrom(instance._snapshots),
        },
      ],
      callback: async (event) => {
        const name = event.options.snapshot_name
        await instance.rpc('load_snapshot', { snapshot: { name } })
        instance.setVariableValues({
          last_snapshot_loaded: `name:${name}`,
        })
      },
    },

    // --- Layouts ---
    set_display_layout_by_id: {
      name: 'Set Display Layout (by IDs)',
      options: [
        {
          type: 'dropdown',
          id: 'display_id',
          label: 'Display',
          choices: idChoiceFrom(instance._displays),
          default: instance._displays?.[0]?.id ?? 1,
        },
        {
          type: 'dropdown',
          id: 'layout_id',
          label: 'Layout (select "Clear" to clear display)',
          choices: [{ id: 'null', label: 'Clear (null)' }, ...idChoiceFrom(instance._layouts)],
          default: instance._layouts?.[0]?.id ?? 'null',
        },
      ],
      callback: async (event) => {
        const did = Number(event.options.display_id)
        const lid = event.options.layout_id === 'null' ? null : { id: Number(event.options.layout_id) }
        await instance.rpc('set_display_layout', { display: { id: did }, layout: lid })
      },
    },

    set_display_layout_by_name: {
      name: 'Set Display Layout (by Names)',
      options: [
        {
          type: 'dropdown',
          id: 'display_name',
          label: 'Display',
          choices: nameChoiceFrom(instance._displays),
          default: instance._displays?.[0]?.name ?? '',
        },
        {
          type: 'dropdown',
          id: 'layout_name',
          label: 'Layout (select "Clear" to clear display)',
          choices: [{ id: 'null', label: 'Clear (null)' }, ...nameChoiceFrom(instance._layouts)],
          default: instance._layouts?.[0]?.name ?? 'null',
        },
      ],
      callback: async (event) => {
        const dname = event.options.display_name
        const lname = event.options.layout_name === 'null' ? null : { name: event.options.layout_name }
        await instance.rpc('set_display_layout', { display: { name: dname }, layout: lname })
      },
    },

    // --- Window source/audio assignment (handy while we’re here) ---
    set_window_input_by_ids: {
      name: 'Set Window Input (by IDs)',
      options: [
        { type: 'dropdown', id: 'display_id', label: 'Display', choices: idChoiceFrom(instance._displays) },
        { type: 'textinput', id: 'window_id', label: 'Window ID', default: '1', useVariables: true, regex: Regex.SIGNED_NUMBER },
        { type: 'textinput', id: 'input_id', label: 'Input ID (blank to clear)', default: '' },
      ],
      callback: async (event) => {
        const display = { id: Number(event.options.display_id) }
        const window = { id: Number(event.options.window_id) }
        const input = String(event.options.input_id || '').trim() === '' ? null : { id: Number(event.options.input_id) }
        await instance.rpc('set_window_input', { display, window, input })
      },
    },

    set_window_audio_by_ids: {
      name: 'Set Window Audio (by IDs)',
      options: [
        { type: 'dropdown', id: 'display_id', label: 'Display', choices: idChoiceFrom(instance._displays) },
        { type: 'textinput', id: 'window_id', label: 'Window ID', default: '1', regex: Regex.SIGNED_NUMBER },
        { type: 'textinput', id: 'audio_index', label: 'Audio Index (blank to clear)', default: '' },
      ],
      callback: async (event) => {
        const display = { id: Number(event.options.display_id) }
        const window = { id: Number(event.options.window_id) }
        const audio = String(event.options.audio_index || '').trim() === '' ? null : { index: Number(event.options.audio_index) }
        await instance.rpc('set_window_audio', { display, window, audio })
      },
    },
  }
}
