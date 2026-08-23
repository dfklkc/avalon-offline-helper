'use strict'

const crypto = require('crypto')

const ROLE_DEFINITIONS = Object.freeze({
  merlin: {
    key: 'merlin',
    label: '梅林',
    camp: 'good',
    description: '你知道大多数邪恶玩家，但必须隐藏自己。'
  },
  percival: {
    key: 'percival',
    label: '派西维尔',
    camp: 'good',
    description: '你能看到梅林与莫甘娜的候选人，但无法分辨二者。'
  },
  loyal: {
    key: 'loyal',
    label: '忠臣',
    camp: 'good',
    description: '你没有额外情报，请从发言与投票中找出邪恶。'
  },
  assassin: {
    key: 'assassin',
    label: '刺客',
    camp: 'evil',
    description: '邪恶阵营。善方完成三次任务后，由你刺杀梅林。'
  },
  morgana: {
    key: 'morgana',
    label: '莫甘娜',
    camp: 'evil',
    description: '邪恶阵营。你会伪装成梅林，迷惑派西维尔。'
  },
  mordred: {
    key: 'mordred',
    label: '莫德雷德',
    camp: 'evil',
    description: '邪恶阵营。梅林无法看到你。'
  },
  oberon: {
    key: 'oberon',
    label: '奥伯伦',
    camp: 'evil',
    description: '邪恶阵营。你与其他邪恶玩家互不可见。'
  },
  minion: {
    key: 'minion',
    label: '爪牙',
    camp: 'evil',
    description: '邪恶阵营。你知道除奥伯伦外的邪恶同伴。'
  }
})

const PLAYER_RULES = Object.freeze({
  5: { good: 3, evil: 2, teamSizes: [2, 3, 2, 3, 3], failThresholds: [1, 1, 1, 1, 1] },
  6: { good: 4, evil: 2, teamSizes: [2, 3, 4, 3, 4], failThresholds: [1, 1, 1, 1, 1] },
  7: { good: 4, evil: 3, teamSizes: [2, 3, 3, 4, 4], failThresholds: [1, 1, 1, 2, 1] },
  8: { good: 5, evil: 3, teamSizes: [3, 4, 4, 5, 5], failThresholds: [1, 1, 1, 2, 1] },
  9: { good: 6, evil: 3, teamSizes: [3, 4, 4, 5, 5], failThresholds: [1, 1, 1, 2, 1] },
  10: { good: 6, evil: 4, teamSizes: [3, 4, 4, 5, 5], failThresholds: [1, 1, 1, 2, 1] }
})

const CLASSIC_EVIL = Object.freeze({
  5: ['assassin', 'morgana'],
  6: ['assassin', 'morgana'],
  7: ['assassin', 'morgana', 'oberon'],
  8: ['assassin', 'morgana', 'mordred'],
  9: ['assassin', 'morgana', 'mordred'],
  10: ['assassin', 'morgana', 'mordred', 'oberon']
})

function getRules(playerCount) {
  const rules = PLAYER_RULES[Number(playerCount)]
  if (!rules) throw new Error('仅支持 5 至 10 人游戏')
  return rules
}
function buildRoleDeck(playerCount, mode = 'classic') {
  const rules = getRules(playerCount)
  const evilRoles = mode === 'beginner'
    ? ['assassin', ...Array(rules.evil - 1).fill('minion')]
    : CLASSIC_EVIL[playerCount]
  const goodSpecials = mode === 'beginner' ? ['merlin'] : ['merlin', 'percival']
  const goodRoles = [
    ...goodSpecials,
    ...Array(rules.good - goodSpecials.length).fill('loyal')
  ]
  const deck = [...goodRoles, ...evilRoles]

  if (deck.length !== Number(playerCount)) throw new Error('角色配置与人数不匹配')
  return deck
}

function secureShuffle(items) {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1)
    ;[result[index], result[swapIndex]] = [result[swapIndex], result[index]]
  }
  return result
}

function publicRole(roleKey) {
  const role = ROLE_DEFINITIONS[roleKey]
  if (!role) throw new Error('未知角色')
  return { ...role }
}

function getKnowledge(selfId, assignments) {
  const selfRole = assignments[selfId]
  const entries = Object.entries(assignments)
  let playerIds = []
  let title = '没有额外情报'
  let description = '观察每个人的发言、组队与投票。'

  if (selfRole === 'merlin') {
    playerIds = entries
      .filter(([, role]) => ROLE_DEFINITIONS[role].camp === 'evil' && role !== 'mordred')
      .map(([playerId]) => playerId)
    title = '你看到的邪恶玩家'
    description = '莫德雷德不会出现在这里；奥伯伦会出现。'
  } else if (selfRole === 'percival') {
    playerIds = entries
      .filter(([, role]) => role === 'merlin' || role === 'morgana')
      .map(([playerId]) => playerId)
    title = '梅林 / 莫甘娜候选'
    description = '候选顺序已打乱，你无法分辨谁是真正的梅林。'
  } else if (ROLE_DEFINITIONS[selfRole].camp === 'evil' && selfRole !== 'oberon') {
    playerIds = entries
      .filter(([playerId, role]) => (
        playerId !== selfId &&
        ROLE_DEFINITIONS[role].camp === 'evil' &&
        role !== 'oberon'
      ))
      .map(([playerId]) => playerId)
    title = '你知道的邪恶同伴'
    description = '奥伯伦不会出现在这里。'
  } else if (selfRole === 'oberon') {
    title = '孤立的邪恶'
    description = '你不知道邪恶同伴，他们也看不到你。'
  }

  return {
    title,
    description,
    playerIds: secureShuffle(playerIds)
  }
}

function normalizeNickname(value) {
  const nickname = String(value || '').trim().replace(/\s+/g, ' ')
  if (!nickname) throw new Error('请输入昵称')
  if ([...nickname].length > 10) throw new Error('昵称最多 10 个字符')
  return nickname
}

function normalizeRoomCode(value) {
  const roomCode = String(value || '').trim().toUpperCase()
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(roomCode)) throw new Error('请输入 6 位房间码')
  return roomCode
}

function nextLeaderIndex(currentIndex, playerCount) {
  return (Number(currentIndex) + 1) % Number(playerCount)
}

function isTeamApproved(votes) {
  const values = Object.values(votes)
  const approvals = values.filter(Boolean).length
  return approvals > values.length / 2
}

function isMissionSuccessful(votes, failThreshold) {
  const failVotes = Object.values(votes).filter((vote) => vote === 'fail').length
  return { succeeded: failVotes < failThreshold, failVotes }
}

module.exports = {
  ROLE_DEFINITIONS,
  PLAYER_RULES,
  getRules,
  buildRoleDeck,
  secureShuffle,
  publicRole,
  getKnowledge,
  normalizeNickname,
  normalizeRoomCode,
  nextLeaderIndex,
  isTeamApproved,
  isMissionSuccessful
}
