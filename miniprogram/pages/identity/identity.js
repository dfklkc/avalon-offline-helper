'use strict'

const game = require('../../services/game')

const ROLE_FALLBACKS = Object.freeze({
  merlin: { key: 'merlin', label: '梅林', camp: 'good', description: '找出邪恶，同时隐藏自己。' },
  percival: { key: 'percival', label: '派西维尔', camp: 'good', description: '分辨梅林与莫甘娜的伪装。' },
  loyal: { key: 'loyal', label: '忠臣', camp: 'good', description: '从发言、组队与投票中找出邪恶。' },
  assassin: { key: 'assassin', label: '刺客', camp: 'evil', description: '阻止任务，或在最后刺杀梅林。' },
  morgana: { key: 'morgana', label: '莫甘娜', camp: 'evil', description: '在派西维尔眼中伪装成梅林。' },
  mordred: { key: 'mordred', label: '莫德雷德', camp: 'evil', description: '梅林无法看到你。' },
  oberon: { key: 'oberon', label: '奥伯伦', camp: 'evil', description: '你与其他邪恶玩家互不可见。' },
  minion: { key: 'minion', label: '爪牙', camp: 'evil', description: '与邪恶同伴合作，破坏圆桌的任务。' }
})

const ROLE_GUIDES = Object.freeze({
  merlin: {
    goal: '帮助善良阵营完成三次任务，并在结尾躲过刺杀。',
    vision: '你能看到除莫德雷德外的邪恶玩家；奥伯伦也在其中。',
    tip: '不要立刻说出所有答案。用提问和温和的组队建议引导队友。'
  },
  percival: {
    goal: '保护真梅林，帮助善良阵营完成三次任务。',
    vision: '你看到梅林与莫甘娜的无序候选人，但不知道谁是真梅林。',
    tip: '比较候选人的信息准确度与保护意识，别过早替某人坐实身份。'
  },
  loyal: {
    goal: '找出邪恶玩家，帮助善良阵营完成三次任务。',
    vision: '你没有开局额外情报。',
    tip: '重点记录谁提名了谁、队伍票与后续任务结果是否自洽。'
  },
  assassin: {
    goal: '让三次任务失败；若善方先成功三次，刺杀梅林翻盘。',
    vision: '你知道除奥伯伦外的邪恶同伴，但不知道他们的具体特殊角色。',
    tip: '记录哪位玩家总能避开坏人，但不要为了找梅林而牺牲当下任务。'
  },
  morgana: {
    goal: '扰乱善方判断，让三次任务失败或帮刺客找到梅林。',
    vision: '你知道除奥伯伦外的邪恶同伴；派西维尔会把你与梅林并列。',
    tip: '给出部分正确信息来像梅林，但要为错误组队保留解释空间。'
  },
  mordred: {
    goal: '利用梅林的盲区混入善方队伍，促成三次任务失败。',
    vision: '你知道除奥伯伦外的邪恶同伴；梅林看不到你。',
    tip: '你很容易获得梅林信任。保持票型合理，别过早暴露这个优势。'
  },
  oberon: {
    goal: '独立破坏善方任务，同时尽量避免干扰其他邪恶玩家的计划。',
    vision: '你不知道任何邪恶同伴，他们也看不到你；但梅林能看到你。',
    tip: '像没有情报的忠臣一样推理，先判断队伍里是否可能已有邪恶。'
  },
  minion: {
    goal: '与邪恶同伴配合，促成三次任务失败。',
    vision: '你知道除奥伯伦外的邪恶同伴，但不知道他们的具体特殊角色。',
    tip: '不要与同伴永远同进退。任务队里有多名邪恶时，谨慎决定谁投失败。'
  }
})

function normalizeRole(role) {
  const key = typeof role === 'string' ? role : role && (role.key || role.role)
  return Object.assign({}, ROLE_FALLBACKS[key] || {
    key: key || 'unknown',
    label: '未知身份',
    camp: 'unknown',
    description: '请返回房间重试。'
  }, typeof role === 'object' && role ? role : {}, ROLE_GUIDES[key] || {
    goal: '完成你所在阵营的胜利条件。',
    vision: '以上方私密情报为准。',
    tip: '结合组队、队伍票与任务汇总做出判断。'
  })
}

function normalizeKnowledge(knowledge) {
  const value = knowledge || {}
  return {
    title: value.title || '没有额外情报',
    description: value.description || '观察每个人的发言、组队与投票。',
    players: Array.isArray(value.players) ? value.players.map((player) => ({
      id: player.id,
      nickname: player.nickname || '未命名玩家',
      seat: player.seat
    })) : []
  }
}

Page({
  data: {
    roomCode: '',
    loading: true,
    error: '',
    revealed: false,
    viewedOnce: false,
    acknowledging: false,
    acknowledged: false,
    visibleRole: null,
    visibleKnowledge: null,
    campClass: ''
  },

  onLoad(options) {
    const roomCode = String((options && options.roomCode) || game.getSavedRoomCode() || '').toUpperCase()
    this.setData({ roomCode })
    this._visible = false
    this._loadGeneration = 0
    this._actionGeneration = 0
    this._needsReload = true
  },

  onShow() {
    this._visible = true
    if (this._needsReload && !this._secretLoading) this.loadSecret()
  },

  onHide() {
    this._visible = false
    this._loadGeneration += 1
    this._actionGeneration += 1
    this._secretLoading = false
    if (this._navigateTimer) clearTimeout(this._navigateTimer)
    this._navigateTimer = null
    this.setData({ acknowledging: false })
    this.clearSecret()
  },

  onUnload() {
    this._visible = false
    this._loadGeneration += 1
    this._actionGeneration += 1
    this._secretLoading = false
    if (this._navigateTimer) clearTimeout(this._navigateTimer)
    this._navigateTimer = null
    this.clearSecret()
  },

  async loadSecret() {
    if (this._secretLoading || !this._visible || !this.data.roomCode) return
    const loadGeneration = ++this._loadGeneration
    this._secretLoading = true
    this._needsReload = false
    this.setData({ loading: true, error: '' })
    try {
      const state = await game.getState(this.data.roomCode)
      if (!this._visible || loadGeneration !== this._loadGeneration) return
      if (!state || !state.privateView || !state.privateView.role) {
        throw new Error('身份尚未发放，请返回房间等待')
      }
      this._secret = {
        role: normalizeRole(state.privateView.role),
        knowledge: normalizeKnowledge(state.privateView.knowledge)
      }
      this.setData({
        loading: false,
        acknowledged: Boolean(state.me && state.me.roleAcknowledged)
      })
    } catch (error) {
      if (!this._visible || loadGeneration !== this._loadGeneration) return
      this._secret = null
      this.setData({
        loading: false,
        error: error.message || '获取身份失败'
      })
    } finally {
      if (loadGeneration === this._loadGeneration) this._secretLoading = false
    }
  },

  revealSecret() {
    if (!this._secret || this.data.revealed) return
    const role = this._secret.role
    this.setData({
      revealed: true,
      viewedOnce: true,
      visibleRole: role,
      visibleKnowledge: this._secret.knowledge,
      campClass: role.camp === 'evil' ? 'camp-evil' : 'camp-good'
    })
  },

  maskSecret() {
    if (!this.data.revealed && !this.data.visibleRole) return
    this.setData({
      revealed: false,
      visibleRole: null,
      visibleKnowledge: null,
      campClass: ''
    })
  },

  clearSecret() {
    this.maskSecret()
    this._secret = null
    this._needsReload = true
  },

  retry() {
    this.loadSecret()
  },

  async acknowledgeRole() {
    if (this.data.acknowledging || this.data.acknowledged || !this.data.viewedOnce) return
    const actionGeneration = ++this._actionGeneration
    this.maskSecret()
    this.setData({ acknowledging: true, error: '' })
    try {
      await game.acknowledgeRole(this.data.roomCode)
      if (!this._visible || actionGeneration !== this._actionGeneration) return
      this.setData({ acknowledged: true })
      wx.showToast({ title: '身份已确认', icon: 'success' })
      this._navigateTimer = setTimeout(() => wx.navigateBack(), 500)
    } catch (error) {
      if (!this._visible || actionGeneration !== this._actionGeneration) return
      this.setData({ error: error.message || '确认失败，请重试' })
    } finally {
      if (this._visible && actionGeneration === this._actionGeneration) {
        this.setData({ acknowledging: false })
      }
    }
  }
})
