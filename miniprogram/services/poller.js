'use strict'

const {
  POLL_INTERVAL_MS,
  POLL_MAX_DELAY_MS
} = require('../config/index')

function createPoller(task, handlers, options) {
  const settings = Object.assign({
    interval: POLL_INTERVAL_MS,
    maxDelay: POLL_MAX_DELAY_MS
  }, options || {})

  let timer = null
  let running = false
  let requestInFlight = false
  let refreshPending = false
  let failures = 0
  let generation = 0

  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function schedule(delay, token) {
    if (!running || token !== generation) return
    clearTimer()
    timer = setTimeout(() => run(token), delay)
  }

  function run(token) {
    if (!running || token !== generation) return Promise.resolve()
    if (requestInFlight) {
      schedule(300, token)
      return Promise.resolve()
    }
    requestInFlight = true

    return Promise.resolve()
      .then(task)
      .then((data) => {
        if (!running || token !== generation) return
        failures = 0
        if (handlers && handlers.onData) handlers.onData(data)
        if (refreshPending) {
          refreshPending = false
          schedule(0, token)
        } else {
          schedule(settings.interval, token)
        }
      })
      .catch((error) => {
        if (!running || token !== generation) return
        failures += 1
        const delay = Math.min(
          settings.interval * Math.pow(2, failures - 1),
          settings.maxDelay
        )
        if (handlers && handlers.onError) handlers.onError(error, delay)
        if (refreshPending) {
          refreshPending = false
          schedule(0, token)
        } else {
          schedule(delay, token)
        }
      })
      .then(
        () => { requestInFlight = false },
        () => { requestInFlight = false }
      )
  }

  return {
    start(immediate) {
      if (running) return
      running = true
      generation += 1
      const token = generation
      schedule(immediate === false ? settings.interval : 0, token)
    },
    stop() {
      running = false
      generation += 1
      failures = 0
      refreshPending = false
      clearTimer()
    },
    refresh() {
      if (!running) return
      clearTimer()
      if (requestInFlight) {
        refreshPending = true
        return
      }
      run(generation)
    },
    isRunning() {
      return running
    }
  }
}

module.exports = { createPoller }
