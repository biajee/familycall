export const STRINGS = {
  zh: {
    appTitle: '家庭通话',
    yourName: '我的名字',
    room: '房间号',
    iSpeak: '我说的语言',
    autoLang: '自动（中文 / English）',
    uiLang: '界面语言',
    simpleMode: '简易模式（打开后只显示一个大按钮）',
    startCall: '开始通话',
    settings: '设置',
    setupHint: '双方输入相同的房间号即可通话。说话内容会以文字显示在双方的屏幕上。',
    quickInfo: (p) => `房间：${p.room}　名字：${p.name}`,
    waitingPeer: '等待对方加入…',
    connecting: '正在连接…',
    reconnecting: '连接中断，正在重新连接…',
    peerLeft: '对方已离开',
    gettingMedia: '正在打开摄像头和麦克风…',
    mediaError: '无法使用摄像头或麦克风，请在手机设置里允许权限后重试',
    mediaAudioOnly: '摄像头不可用，仅使用语音',
    wsError: '无法连接服务器，请检查网络',
    room_full: '房间已满（最多两人）',
    bad_key: '房间密码错误',
    bad_room: '房间号无效',
    mute: '静音',
    unmute: '取消静音',
    camOff: '关闭摄像头',
    camOn: '打开摄像头',
    flip: '切换摄像头',
    fontUp: '字幕放大',
    fontDown: '字幕缩小',
    hangup: '挂断',
    hangupConfirm: '确定要挂断吗？',
    captionsOff: '字幕服务未连接',
    captionsOn: '字幕已开启',
    captionsIdle: '字幕',
    tapToPlay: '请点击屏幕以播放声音',
    noAutoLang: '服务器不支持自动识别语言，已按中文识别',
    inviteCopy: '📋 复制房间链接',
    inviteCopied: '链接已复制，用微信发给对方，点开就能加入通话。',
    inviteNeedRoom: '请先填写房间号',
    inviteManual: '请手动复制这个链接：',
  },
  en: {
    appTitle: 'Family Call',
    yourName: 'My name',
    room: 'Room',
    iSpeak: 'I speak',
    autoLang: 'Auto (中文 / English)',
    uiLang: 'Interface language',
    simpleMode: 'Simple mode (show only one big button)',
    startCall: 'Start call',
    settings: 'Settings',
    setupHint: 'Both sides enter the same room name to connect. Everything said is shown as text on both screens.',
    quickInfo: (p) => `Room: ${p.room} · Name: ${p.name}`,
    waitingPeer: 'Waiting for the other person…',
    connecting: 'Connecting…',
    reconnecting: 'Connection lost, reconnecting…',
    peerLeft: 'The other person left',
    gettingMedia: 'Opening camera and microphone…',
    mediaError: 'Camera/microphone unavailable. Allow the permission in your phone settings and try again.',
    mediaAudioOnly: 'Camera unavailable, using audio only',
    wsError: 'Cannot reach the server, check your network',
    room_full: 'Room is full (2 people max)',
    bad_key: 'Wrong room key',
    bad_room: 'Invalid room name',
    mute: 'Mute',
    unmute: 'Unmute',
    camOff: 'Camera off',
    camOn: 'Camera on',
    flip: 'Switch camera',
    fontUp: 'Bigger captions',
    fontDown: 'Smaller captions',
    hangup: 'Hang up',
    hangupConfirm: 'Hang up?',
    captionsOff: 'Captions not connected',
    captionsOn: 'Captions on',
    captionsIdle: 'Captions',
    tapToPlay: 'Tap the screen to play sound',
    noAutoLang: 'Server cannot auto-detect language; using Chinese',
    inviteCopy: '📋 Copy room link',
    inviteCopied: 'Link copied — send it over; one tap joins the call.',
    inviteNeedRoom: 'Enter a room name first',
    inviteManual: 'Copy this link manually:',
  },
};

export function detectUiLang() {
  const l = (navigator.language || 'en').toLowerCase();
  return l.startsWith('zh') ? 'zh' : 'en';
}

export function applyI18n(ui) {
  const T = STRINGS[ui] || STRINGS.en;
  document.documentElement.lang = ui === 'zh' ? 'zh-CN' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const v = T[el.dataset.i18n];
    if (typeof v === 'string') el.textContent = v;
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    const v = T[el.dataset.i18nTitle];
    if (typeof v === 'string') { el.title = v; el.setAttribute('aria-label', v); }
  }
  return T;
}
