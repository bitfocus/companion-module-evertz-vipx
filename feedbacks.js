export function getFeedbacks(instance) {
  return {
    connected: {
      name: 'Connected',
      type: 'boolean',
      defaultStyle: { color: 16777215, bgcolor: 32768 }, // white on green
      options: [],
      callback: () => instance._connected === true,
    },
  }
}
