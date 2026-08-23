'use strict'

const { CLOUD_ENV } = require('./config/index')

App({
  onLaunch() {
    if (!wx.cloud) {
      this.globalData.cloudReady = false
      return
    }

    const options = { traceUser: true }
    if (CLOUD_ENV) options.env = CLOUD_ENV
    wx.cloud.init(options)
    this.globalData.cloudReady = true
  },

  globalData: {
    cloudReady: false
  }
})
