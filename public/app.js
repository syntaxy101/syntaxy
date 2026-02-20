//* ─── API CONNECTION ─── */
const API_URL = 'https://syntaxy-production-d83f.up.railway.app/api';

function getToken() {
  return localStorage.getItem('syntaxy_token');
}

function setToken(token) {
  localStorage.setItem('syntaxy_token', token);
}

function removeToken() {
  localStorage.removeItem('syntaxy_token');
}

async function api(endpoint, options = {}) {
  const token = getToken();

  const config = {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    }
  };

  if (options.body) {
    config.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${API_URL}${endpoint}`, config);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'API Error');
  }

  return data;
}

async function loadUserData() {
  try {
    // Load user's servers
    const servers = await api('/servers');

    // Clear existing servers except 'home'
    S.servers = S.servers.filter(s => s.id === 'home');

    // Add servers from database
    for (const srv of servers) {
      // Load channels for this server
      const channels = await api(`/servers/${srv.id}/channels`);

      S.servers.push({
        id: srv.id,
        name: srv.name,
        icon: srv.icon || srv.name[0],
        iconImg: srv.icon_img || '',
        banner: srv.banner || '',
        isAdmin: srv.owner_id === S.me.id,
        defChBg: srv.def_ch_bg || '',
        aesthetics: srv.aesthetics || {
          bg: '#0d1117',
          surface: '#161b22',
          acc1: srv.accent || '#58a6ff',
          acc2: '#3fb950',
          text: '#c9d1d9',
          border: '#30363d',
          sidebarStyle: 'solid',
          sidebarGrad1: '#161b22',
          sidebarGrad2: '#1c2333'
        },
        channels: channels.map(ch => ({
          id: ch.id,
          name: ch.name,
          desc: ch.description || '',
          type: 'ch',
          bg: ch.background || '',
          msgs: [] // Messages loaded when channel is opened
        })),
        dms: []
      });
    }

    // Set initial server/channel if we have servers
    if (S.servers.length > 1) {
      S.srvId = S.servers[1].id; // First real server (not 'home')
      S.chId = S.servers[1].channels[0]?.id;
      S.view = 'server';
    }
  } catch (err) {
    console.error('Failed to load user data:', err);
  }
}

async function loadDMsFromDatabase() {
  try {
    if (!getToken()) return;

    const dms = await api('/dms');
    const homeServer = S.servers.find(s => s.id === 'home');

    if (!homeServer) return;

    // Clear existing DMs
    homeServer.dms = [];

    // Add DMs from database
    for (const dm of dms) {
      const otherUserId = dm.user1_id === S.me.id ? dm.user2_id : dm.user1_id;
      const otherUsername = dm.user1_id === S.me.id ? dm.user2_username : dm.user1_username;
      const otherDisplayName = dm.user1_id === S.me.id ? dm.user2_display_name : dm.user1_display_name;

      homeServer.dms.push({
        id: dm.id,
        name: otherDisplayName || otherUsername,
        userId: otherUserId,
        type: 'dm',
        bg: dm.background || '',
        msgs: []
      });

      // Track last activity for sorting
      if (dm.last_message_at || dm.updated_at || dm.created_at) {
        S.dmLastActivity[dm.id] = dm.last_message_at || dm.updated_at || dm.created_at;
      }

      // Add/update user so U() has fresh data
      const otherAvatar = dm.user1_id === S.me.id ? dm.user2_avatar : dm.user1_avatar;
      const otherColor = dm.user1_id === S.me.id ? dm.user2_color : dm.user1_color;
      upsertUser({
        id: otherUserId,
        name: otherDisplayName || otherUsername,
        color: otherColor || '#58a6ff',
        avatar: otherAvatar || ''
      });
    }

    renderSidebar();
  } catch (err) {
    console.error('Failed to load DMs:', err);
  }
}

/* ─── STATE ─── */
const S={
  me:{id:'me',name:'',color:'#58a6ff',accent:'#3fb950',bio:'',avatar:'',banner:'',gallery:{items:[],bg:'',bgColor:'#0d1117',surface:'#161b22',acc1:'#58a6ff',acc2:'#3fb950',text:'#c9d1d9',border:'#30363d'}},
  personalUI:{
    override:false,
    bg:'#0d1117',
    surface:'#161b22',
    acc1:'#58a6ff',
    acc2:'#3fb950',
    text:'#c9d1d9',
    border:'#30363d',
    sidebarStyle:'solid',
    sidebarGrad1:'#161b22',
    sidebarGrad2:'#1c2333'
  },
  users:[], // No more placeholder bots - all real users from database
  servers:[],
  srvId:null, chId:null,
  view:'dms', // 'server' | 'dms'
  replyTo:null, pendingImg:null, pendingChBg:null, ctxId:null, ctxChId:null,
  searchActive:false, editingChannelId:null, currentGalleryUserId:null,
  unreadDMs:{}, dmLastActivity:{}, pinnedDMs:[]
};

/* ─── INDEXEDDB PERSISTENCE ─── */
const DB_NAME = 'syntaxy_db';
const DB_VERSION = 2;
const STORE_NAME = 'app_state';
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

// Compress image to reduce size
function compressImage(base64, maxWidth = 800, quality = 0.7) {
  return new Promise((resolve) => {
    // Skip if not an image or if it's a GIF (preserve animation)
    if (!base64 || !base64.startsWith('data:image')) {
      resolve(base64);
      return;
    }

    // Don't compress GIFs - they lose animation
    if (base64.startsWith('data:image/gif')) {
      resolve(base64);
      return;
    }

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;

      if (width > maxWidth) {
        height = (height * maxWidth) / width;
        width = maxWidth;
      }

      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(base64);
    img.src = base64;
  });
}

// Deep clone and compress images in object
async function prepareForSave(obj) {
  const clone = JSON.parse(JSON.stringify(obj));

  // Compress user avatars and banners
  if (clone.me) {
    if (clone.me.avatar) clone.me.avatar = await compressImage(clone.me.avatar, 400, 0.8);
    if (clone.me.banner) clone.me.banner = await compressImage(clone.me.banner, 800, 0.7);
    if (clone.me.gallery) {
      if (clone.me.gallery.bg) clone.me.gallery.bg = await compressImage(clone.me.gallery.bg, 1200, 0.6);
      if (clone.me.gallery.items) {
        for (let i = 0; i < clone.me.gallery.items.length; i++) {
          if (clone.me.gallery.items[i].type === 'image') {
            clone.me.gallery.items[i].src = await compressImage(clone.me.gallery.items[i].src, 800, 0.7);
          }
        }
      }
    }
  }

  // Compress other users
  if (clone.users) {
    for (const user of clone.users) {
      if (user.avatar) user.avatar = await compressImage(user.avatar, 400, 0.8);
      if (user.banner) user.banner = await compressImage(user.banner, 800, 0.7);
    }
  }

  // Compress server images and messages
  if (clone.servers) {
    for (const srv of clone.servers) {
      if (srv.iconImg) srv.iconImg = await compressImage(srv.iconImg, 200, 0.8);
      if (srv.banner) srv.banner = await compressImage(srv.banner, 800, 0.7);
      if (srv.defChBg) srv.defChBg = await compressImage(srv.defChBg, 1200, 0.6);

      // Compress channel backgrounds and message images
      if (srv.channels) {
        for (const ch of srv.channels) {
          if (ch.bg) ch.bg = await compressImage(ch.bg, 1200, 0.6);
          if (ch.msgs) {
            for (const msg of ch.msgs) {
              if (msg.img) msg.img = await compressImage(msg.img, 600, 0.7);
            }
          }
        }
      }

      // Compress DM backgrounds and message images
      if (srv.dms) {
        for (const dm of srv.dms) {
          if (dm.bg) dm.bg = await compressImage(dm.bg, 1200, 0.6);
          if (dm.msgs) {
            for (const msg of dm.msgs) {
              if (msg.img) msg.img = await compressImage(msg.img, 600, 0.7);
            }
          }
        }
      }
    }
  }

  return clone;
}

async function saveState() {
  if (!db) return;

  try {
    const prepared = await prepareForSave({
      me: S.me,
      personalUI: S.personalUI,
      users: S.users,
      servers: S.servers,
      srvId: S.srvId,
      chId: S.chId,
      view: S.view,
      unreadDMs: S.unreadDMs,
      dmLastActivity: S.dmLastActivity,
      pinnedDMs: S.pinnedDMs
    });

    const dataToSave = {
      id: 'main',
      ...prepared
    };

    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(dataToSave);

    tx.oncomplete = () => console.log('State saved successfully');
    tx.onerror = (e) => console.warn('Save error:', e);
  } catch(e) {
    console.warn('Failed to save state:', e);
  }
}

function loadState() {
  return new Promise((resolve) => {
    if (!db) {
      resolve(false);
      return;
    }

    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get('main');

      request.onsuccess = () => {
        const data = request.result;
        if (data) {
          if (data.me) S.me = data.me;
          if (data.personalUI) S.personalUI = data.personalUI;
          if (data.users) S.users = data.users;
          if (data.servers && data.servers.length > 0) S.servers = data.servers;
          if (data.srvId) S.srvId = data.srvId;
          if (data.chId) S.chId = data.chId;
          if (data.view) S.view = data.view;
          if (data.unreadDMs) S.unreadDMs = data.unreadDMs;
          if (data.dmLastActivity) S.dmLastActivity = data.dmLastActivity;
          if (data.pinnedDMs) S.pinnedDMs = data.pinnedDMs;

          // Ensure we have valid server/channel references
          if (!S.servers.find(s => s.id === S.srvId)) {
            S.srvId = S.servers[0]?.id || 'home';
          }
          const currentSrv = S.servers.find(s => s.id === S.srvId);
          if (currentSrv) {
            const allChannels = [...(currentSrv.channels || []), ...(currentSrv.dms || [])];
            if (!allChannels.find(c => c.id === S.chId) && allChannels.length > 0) {
              S.chId = allChannels[0].id;
            }
          }

          // Ensure all channels have msgs arrays
          S.servers.forEach(srv => {
            if(srv.channels) {
              srv.channels.forEach(ch => {
                if(!ch.msgs) ch.msgs = [];
              });
            }
            if(srv.dms) {
              srv.dms.forEach(dm => {
                if(!dm.msgs) dm.msgs = [];
              });
            }
          });

          console.log('State loaded successfully', {servers: S.servers.length, srvId: S.srvId, chId: S.chId});
          resolve(true);
        } else {
          resolve(false);
        }
      };

      request.onerror = () => {
        console.warn('Failed to load state');
        resolve(false);
      };
    } catch(e) {
      console.warn('Failed to load state:', e);
      resolve(false);
    }
  });
}

// Ensure all users have proper gallery structure
function ensureGalleryDefaults() {
  const defaultGallery = {
    items: [],
    bg: '',
    bgColor: '#0d1117',
    surface: '#161b22',
    acc1: '#58a6ff',
    acc2: '#3fb950',
    text: '#c9d1d9',
    border: '#30363d'
  };

  if (!S.me.gallery) S.me.gallery = {...defaultGallery};
  else S.me.gallery = {...defaultGallery, ...S.me.gallery};

  S.users.forEach(u => {
    if (!u.gallery) u.gallery = {...defaultGallery, acc1: u.color, acc2: u.accent};
    else u.gallery = {...defaultGallery, ...u.gallery};
  });
}

// Auto-save on changes (debounced)
let saveTimeout;
function autoSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveState, 1000);
}

// Sync settings (gallery + personalUI) to server database
let syncTimeout;
function syncSettingsToServer() {
  clearTimeout(syncTimeout);
  syncTimeout = setTimeout(async () => {
    try {
      if (!getToken()) return;
      await api('/users/settings', {
        method: 'PUT',
        body: {
          gallery: S.me.gallery,
          personal_ui: S.personalUI
        }
      });
      console.log('Settings synced to server');
    } catch(e) {
      console.warn('Failed to sync settings:', e);
    }
  }, 1500);
}

// Sync full profile to server database
async function syncProfileToServer() {
  try {
    if (!getToken()) return;
    await api('/users/profile', {
      method: 'PUT',
      body: {
        display_name: S.me.name,
        bio: S.me.bio,
        color: S.me.color,
        accent: S.me.accent,
        avatar: S.me.avatar,
        banner: S.me.banner,
        gallery: S.me.gallery,
        personal_ui: S.personalUI
      }
    });
    console.log('Profile synced to server');
    // Notify other users via WebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'profile_update',
        user: {
          id: S.me.id,
          display_name: S.me.name,
          color: S.me.color,
          accent: S.me.accent,
          avatar: S.me.avatar,
          banner: S.me.banner,
          bio: S.me.bio
        }
      }));
    }
  } catch(e) {
    console.warn('Failed to sync profile:', e);
  }
}

function updateProfilePreview() {
  const name = document.getElementById('p-name').value || S.me.name || 'User';
  const bio = document.getElementById('p-bio').value || '';
  const color = document.getElementById('p-color').value;
  const accent = document.getElementById('p-accent').value;
  const gradient = `linear-gradient(135deg, ${color}, ${accent})`;
  const primaryDark = darkenColor(color, 0.7);

  const card = document.getElementById('preview-profile-card');
  card.style.setProperty('--pc-primary', primaryDark);
  card.style.setProperty('--pc-accent-fade', `${accent}15`);
  card.style.background = primaryDark;
  card.style.border = `1px solid ${color}30`;

  const banner = document.getElementById('preview-pc-banner');
  const avatarFile = document.getElementById('ub-avatar').querySelector('input').files[0];
  const bannerFile = document.getElementById('ub-banner').querySelector('input').files[0];

  if(bannerFile) {
    readF(bannerFile).then(src => {
      banner.style.background = `url(${src}) center/cover`;
    });
  } else if(S.me.banner) {
    banner.style.background = `url(${S.me.banner}) center/cover`;
  } else {
    banner.style.background = gradient;
  }

  const avDiv = document.getElementById('preview-pc-av');
  if(avatarFile) {
    readF(avatarFile).then(src => {
      avDiv.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:cover;">`;
    });
  } else if(S.me.avatar) {
    avDiv.innerHTML = `<img src="${S.me.avatar}" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    avDiv.innerHTML = `<div class="default-av" style="width:100%;height:100%;background:${color};color:#fff;font-size:34px;display:flex;align-items:center;justify-content:center">✦</div>`;
  }

  document.getElementById('preview-pc-name').textContent = name;
  document.getElementById('preview-pc-name').style.color = color;
  document.getElementById('preview-pc-bio').textContent = bio || 'No bio yet';

  // Update button gradient
  const btn = document.getElementById('preview-profile-btn');
  if(btn) btn.style.background = gradient;
}

// Initialize app
async function initApp() {
  // Show login screen immediately while loading
  const loginScreen = document.getElementById('login-screen');

  await openDB();
  const hasLoaded = await loadState();

  if (!hasLoaded) {
    // build DMs - create a special "home" server just for DMs
    S.servers.push({
      id: 'home', name: 'Home', icon: '🏠', isAdmin: true,
      banner: '', defChBg: '', iconImg: '',
      aesthetics: {
        bg: '#0d1117',
        surface: '#161b22',
        acc1: '#58a6ff',
        acc2: '#3fb950',
        text: '#c9d1d9',
        border: '#30363d',
        sidebarStyle: 'solid',
        sidebarGrad1: '#161b22',
        sidebarGrad2: '#1c2333',
        sidebarOpacity:1,
        sidebarBlur:10
      },
      channels: [],
      dms: []
    });
    S.users.forEach(u => S.servers[0].dms.push({ id: 'dm_' + u.id, name: u.name, userId: u.id, type: 'dm', bg: '', msgs: [] }));
    S.srvId = 'home';
    S.chId = 'dm_u1';

    // seed
    S.servers[0].dms[0].msgs = [
      { id: 10, uid: 'u1', text: 'hey!! check out the new theme engine', img: null, reply: null, time: T(), edited: false },
      { id: 11, uid: 'u1', text: 'I made my chat look like a sunset 🌅', img: null, reply: null, time: T(), edited: false }
    ];
  }

  // Ensure gallery defaults
  ensureGalleryDefaults();
  
  _loadedChannels.clear();

  // Check if user is logged in
  const isLoggedIn = S.me.name && S.me.name.trim() !== '';

  if (isLoggedIn) {
    loginScreen.style.display = 'none';
    await loadDMsFromDatabase();
    renderAll();
    initWebSocket();
  } else {
    loginScreen.style.display = 'flex';
    // Don't renderAll yet - wait for login
  }
}

// ADD THIS FUNCTION - it was referenced but never defined
document.getElementById('btn-profile').onclick=()=>{
  document.getElementById('p-name').value = S.me.name || '';
  document.getElementById('p-bio').value = S.me.bio || '';
  document.getElementById('p-color').value = S.me.color || '#58a6ff';
  document.getElementById('p-accent').value = S.me.accent || '#3fb950';
  const bioCounter = document.getElementById('bio-counter');
  if(bioCounter) bioCounter.textContent = `${(S.me.bio||'').length}/50`;
  const prev = document.getElementById('profile-grad-preview');
  if(prev) prev.style.background = `linear-gradient(135deg, ${S.me.color||'#58a6ff'}, ${S.me.accent||'#3fb950'})`;
  const avatarInput = document.getElementById('ub-avatar').querySelector('input');
  const bannerInput = document.getElementById('ub-banner').querySelector('input');
  if(avatarInput) avatarInput.value = '';
  if(bannerInput) bannerInput.value = '';

  openM('m-profile');
  openM('m-profile-preview');
  updateProfilePreview();
};

// Start the app
initApp();


function T(){return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}

/* ─── HELPERS ─── */
// Cache for fetchFullUser - avoid repeated API calls
const _userFetchCache = {};
const USER_CACHE_TTL = 60000; // 60 seconds

async function fetchFullUser(uid) {
  const now = Date.now();
  const cached = U(uid);
  if (_userFetchCache[uid] && (now - _userFetchCache[uid] < USER_CACHE_TTL) && cached.name !== 'User') {
    return cached;
  }
  try {
    const data = await api(`/users/${uid}`);
    _userFetchCache[uid] = now;
    upsertUser({
      id: data.id,
      name: data.display_name || data.username,
      color: data.color,
      accent: data.accent,
      avatar: data.avatar,
      banner: data.banner,
      bio: data.bio,
      gallery: data.gallery || {}
    });
    return U(uid);
  } catch (err) {
    console.error('Failed to fetch user:', err);
    return cached;
  }
}

function upsertUser(userData) {
  if (!userData || userData.id === S.me.id) return;
  const existing = S.users.find(u => u.id === userData.id);
  if (existing) {
    existing.name = userData.name || existing.name;
    existing.color = userData.color || existing.color;
    existing.accent = userData.accent || existing.accent;
    existing.avatar = userData.avatar !== undefined ? userData.avatar : existing.avatar;
    existing.banner = userData.banner !== undefined ? userData.banner : existing.banner;
    existing.bio = userData.bio !== undefined ? userData.bio :
    existing.bio;
    if (userData.gallery) existing.gallery = userData.gallery;
  } else {
    S.users.push({
      id: userData.id,
      name: userData.name || 'User',
      color: userData.color || '#58a6ff',
      accent: userData.accent || '#3fb950',
      avatar: userData.avatar || '',
      banner: userData.banner || '',
      bio: userData.bio || '',
      gallery: userData.gallery || { items:[], bg:'', bgColor:'#0d1117', surface:'#161b22', acc1:'#58a6ff', acc2:'#3fb950', text:'#c9d1d9', border:'#30363d' }
    });
  }
}

function U(id) {
  if (id === 'me') return S.me;

  // Check local users first
  const localUser = S.users.find(u => u.id === id);
  if (localUser) return localUser;

  // For database user IDs, create a placeholder
  // The actual username comes from the message data
  return { name: 'User', color: '#58a6ff', avatar: '', banner: '', bio: '' };
}
function srv(){return S.servers.find(s=>s.id===S.srvId)}
function ch(){const s=srv();return s.channels.find(c=>c.id===S.chId)||s.dms.find(d=>d.id===S.chId)}
function readF(f){return new Promise(r=>{const rd=new FileReader();rd.onload=e=>r(e.target.result);rd.readAsDataURL(f)})}

// Upload file to S3 and return URL
async function uploadFileToS3(file) {
  const formData = new FormData();
  formData.append('file', file);
  const token = getToken();
  const resp = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData
  });
  if (!resp.ok) throw new Error('Upload failed');
  const data = await resp.json();
  return data.url;
}
function linkify(t){return(t||'').replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>')}
function avHTML(u,sz){
  sz=sz||34;
  if(u.avatar) return`<img src="${u.avatar}" style="width:${sz}px;height:${sz}px;object-fit:cover;">`;
  return`<div class="default-av" style="width:${sz}px;height:${sz}px;background:${u.color};color:#fff;font-size:${Math.round(sz*.5)}px">✦</div>`;
}
function darkenColor(hex, factor) {
  const r = Math.round(parseInt(hex.slice(1,3),16) * factor);
  const g = Math.round(parseInt(hex.slice(3,5),16) * factor);
  const b = Math.round(parseInt(hex.slice(5,7),16) * factor);
  return '#' + [r,g,b].map(v => Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0')).join('');
}
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ─── THEME ENGINE ─── */
function getCurrentTheme(){
  if(S.view === 'dms' || S.personalUI.override) {
    return S.personalUI;
  }
  return srv().aesthetics;
}

function lighten(hex,a){
  let r=parseInt(hex.slice(1,3),16)+a;
  let g=parseInt(hex.slice(3,5),16)+a;
  let b=parseInt(hex.slice(5,7),16)+a;
  return'#'+[r,g,b].map(v=>Math.min(255,Math.max(0,v)).toString(16).padStart(2,'0')).join('');
}

function applyTheme(t){
  const r=document.documentElement.style;
  r.setProperty('--bg',t.bg);
  r.setProperty('--surface',t.surface);
  r.setProperty('--surface2',lighten(t.surface,12));
  r.setProperty('--accent',t.acc1);
  r.setProperty('--accent2',t.acc2);
  r.setProperty('--text',t.text);
  r.setProperty('--border',t.border);
  r.setProperty('--grad',`linear-gradient(135deg,${t.acc1},${t.acc2})`);

  // Sidebar opacity and blur
  const sidebarOpacity = t.sidebarOpacity !== undefined ? t.sidebarOpacity : 1;
  const sidebarBlur = t.sidebarBlur !== undefined ? t.sidebarBlur : 10;
  const sidebarBgMode = t.sidebarBgMode || 'color';
  const sidebar = document.getElementById('channel-sidebar');
  const sidebarBgLayer = document.getElementById('sidebar-bg-layer');

  if(sidebar) {
    sidebar.style.backgroundColor = hexToRgba(t.surface, sidebarOpacity);
    r.setProperty('--sidebar-blur', sidebarBlur + 'px');
  }

  // Apply channel background to sidebar if in image mode
  if(sidebarBgLayer) {
    const c = ch();
    const channelBg = c ? (c.bg || srv().defChBg || '') : '';

    if(sidebarBgMode === 'image' && channelBg) {
      sidebarBgLayer.style.backgroundImage = `url(${channelBg})`;
      sidebarBgLayer.classList.add('show-image');
    } else {
      sidebarBgLayer.style.backgroundImage = '';
      sidebarBgLayer.classList.remove('show-image');
    }
  }

  // Sidebar gradient
  if(t.sidebarStyle === 'gradient') {
    const grad1 = hexToRgba(t.sidebarGrad1, sidebarOpacity);
    const grad2 = hexToRgba(t.sidebarGrad2, sidebarOpacity);
    r.setProperty('--sidebar-grad',`linear-gradient(180deg,${grad1},${grad2})`);
    document.getElementById('sidebar-body').classList.add('gradient-bg');
  } else {
    document.getElementById('sidebar-body').classList.remove('gradient-bg');
  }

  document.getElementById('btn-send').style.background=`linear-gradient(135deg,${t.acc1},${t.acc2})`;
}

/* ─── RENDER ─── */
function renderRail(){
  const el=document.getElementById('server-rail'); el.innerHTML='';
  const tooltip = document.getElementById('rail-tooltip');

  function showTooltip(e, text) {
    const rect = e.target.closest('.rail-icon').getBoundingClientRect();
    tooltip.textContent = text;
    tooltip.style.left = (rect.right + 10) + 'px';
    tooltip.style.top = (rect.top + rect.height/2) + 'px';
    tooltip.style.opacity = '1';
  }

  function hideTooltip() {
    tooltip.style.opacity = '0';
  }

  // DM icon
  const dm=document.createElement('div');
  dm.className='rail-icon'+(S.view==='dms'?' active':'');
  dm.innerHTML='💬';
  dm.onclick=()=>{
    S.view='dms';
    S.srvId='home';
    const homeServer = S.servers.find(s => s.id === 'home');
    if(homeServer && homeServer.dms.length > 0) {
      S.chId = homeServer.dms[0].id;
    }
    renderAll();
    autoSave();
  };
  dm.onmouseenter = (e) => showTooltip(e, 'Direct Messages');
  dm.onmouseleave = hideTooltip;
  el.appendChild(dm);
  el.appendChild(Object.assign(document.createElement('div'),{className:'rail-divider'}));

  // servers (skip the 'home' server as it's just for DMs)
  S.servers.forEach(s=>{
    if(s.id === 'home') return;
    const i=document.createElement('div');
    i.className='rail-icon'+(S.view==='server'&&s.id===S.srvId?' active':'');
    i.innerHTML=s.iconImg?`<img src="${s.iconImg}">`:(s.icon||s.name[0]);
    i.onclick=()=>{S.view='server';S.srvId=s.id;S.chId=s.channels[0].id;renderAll();autoSave()};
    i.onmouseenter = (e) => showTooltip(e, s.name);
    i.onmouseleave = hideTooltip;

    // Drag-to-reorder
    i.draggable = true;
    i.dataset.srvId = s.id;
    i.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', s.id);
      i.style.opacity = '0.4';
      hideTooltip();
    });
    i.addEventListener('dragend', () => { i.style.opacity = '1'; });
    i.addEventListener('dragover', e => {
      e.preventDefault();
      i.style.borderTop = '2px solid var(--accent)';
    });
    i.addEventListener('dragleave', () => { i.style.borderTop = ''; });
    i.addEventListener('drop', e => {
      e.preventDefault();
      i.style.borderTop = '';
      const draggedId = isNaN(e.dataTransfer.getData('text/plain'))
      ? e.dataTransfer.getData('text/plain')
      : Number(e.dataTransfer.getData('text/plain'));
      const targetId = s.id;
      if (draggedId === targetId) return;
      const fromIdx = S.servers.findIndex(sv => sv.id === draggedId);
      const toIdx = S.servers.findIndex(sv => sv.id === targetId);
      if (fromIdx > -1 && toIdx > -1) {
        const [moved] = S.servers.splice(fromIdx, 1);
        S.servers.splice(toIdx, 0, moved);
        renderRail();
        autoSave();
      }
    });

    el.appendChild(i);
  });

  // add button
  const a=document.createElement('div');
  a.className='rail-icon';
  a.innerHTML='<span class="rail-add">+</span>';
  a.onclick=()=>openM('m-newsrv');
  a.onmouseenter = (e) => showTooltip(e, 'Create Server');
  a.onmouseleave = hideTooltip;
  el.appendChild(a);

  // join server button
  const j=document.createElement('div');
  j.className='rail-icon';
  j.innerHTML='<span class="rail-add" style="font-size:16px">📩</span>';
  j.onclick=()=>{
    document.getElementById('join-invite-code').value='';
    document.getElementById('invite-preview').style.display='none';
    document.getElementById('invite-error').style.display='none';
    openM('m-joinsrv');
  };
  j.onmouseenter = (e) => showTooltip(e, 'Join Server');
  j.onmouseleave = hideTooltip;
  el.appendChild(j);
}

function renderSidebar(){
  const body=document.getElementById('sidebar-body'); body.innerHTML='';
  const s=srv();

  // Server banner
  const banner = document.getElementById('server-banner');
  if(S.view === 'server' && s && s.banner) {
    banner.style.backgroundImage = `url(${s.banner})`;
    banner.classList.add('visible');
  } else {
    banner.style.backgroundImage = '';
    banner.classList.remove('visible');
  }

  if(S.view==='dms'){
    document.getElementById('sidebar-title').textContent='Direct Messages';

    // Add explore planet button next to the title
    const titleEl = document.getElementById('sidebar-title');
    titleEl.innerHTML = 'Direct Messages <button class="explore-planet-btn" id="btn-explore" title="Explore">🪐</button>';
    document.getElementById('btn-explore').onclick = () => openExplorePage();

    document.getElementById('btn-srv-set').style.display='none';
    document.getElementById('btn-friends').style.display='';
    updateFriendBadge();

    const homeServer = S.servers.find(srv => srv.id === 'home');
    const dmList = homeServer ? homeServer.dms : [];

    // Sort DMs: pinned first, then by last activity
    dmList.sort((a, b) => {
      const pinA = S.pinnedDMs.includes(a.id) ? 1 : 0;
      const pinB = S.pinnedDMs.includes(b.id) ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;
      const tA = S.dmLastActivity[a.id] || '';
      const tB = S.dmLastActivity[b.id] || '';
      if (tA && tB) return new Date(tB) - new Date(tA);
      if (tA) return -1;
      if (tB) return 1;
      return 0;
    });
    // ADD SEARCH USERS BUTTON
    const searchBtn = document.createElement('button');
    searchBtn.id = 'open-user-search-btn';
    searchBtn.textContent = '🔍 Search Users';
    searchBtn.style.cssText = 'width:calc(100% - 16px);padding:10px;margin:8px;background:linear-gradient(135deg,#58a6ff,#3fb950);color:white;border:none;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer;transition:filter 0.2s;font-family:Inter,sans-serif';
    searchBtn.onclick = () => {
      document.getElementById('user-search-overlay').classList.add('show');
      document.getElementById('user-search-input').focus();
    };
    body.appendChild(searchBtn);

    // Show "No DMs yet" message if empty
    if (dmList.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = 'text-align:center;padding:40px 20px;color:var(--dim);font-size:13px;line-height:1.6';
      emptyMsg.innerHTML = `
      <div style="font-size:48px;margin-bottom:12px;opacity:0.3">💬</div>
      <div style="font-weight:600;margin-bottom:8px">No Direct Messages Yet</div>
      <div style="font-size:12px;opacity:0.8">Search for users above to start a conversation</div>
      `;
      body.appendChild(emptyMsg);
      return; // Don't try to render DM list
    }

    dmList.forEach(d=>{
      const u=U(d.userId);

      const el=document.createElement('div');
      const unreadCount = S.unreadDMs[d.id] || 0;
      const isPinned = S.pinnedDMs.includes(d.id);
      el.className='ch-item'+(d.id===S.chId?' active':'')+(unreadCount?' dm-unread':'');
      el.dataset.dmid = d.id;

      const countLabel = unreadCount > 10 ? '10+' : (unreadCount > 0 ? String(unreadCount) : '');
      const pinIcon = isPinned ? '<span class="dm-pin-icon" title="Pinned">📌</span>' : '';
      const badgeHTML = countLabel ? `<span class="dm-unread-badge">${countLabel}</span>` : '';

      el.innerHTML=`<div class="dm-av-sm">${avHTML(u,24)}</div>${pinIcon}<span class="ch-name">${u.name}</span>${badgeHTML}`;
      el.onclick=()=>{
        S.chId=d.id;
        delete S.unreadDMs[d.id];
        renderAll();
        autoSave();
      };
      // Right-click for DM context menu
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        openDMCtx(e, d.id);
      });
      body.appendChild(el);
    });
  } else {
    document.getElementById('sidebar-title').textContent=s.name;
    // channels
    // Show server settings button when not in DMs
    document.getElementById('btn-srv-set').style.display='flex';
    document.getElementById('btn-friends').style.display='none';
    const cl=document.createElement('div'); cl.className='sec-label';
    cl.innerHTML='CHANNELS <button id="btn-addch">+</button>'; body.appendChild(cl);
    document.getElementById('btn-addch').onclick=()=>openM('m-newch');
    s.channels.forEach(c=>{
      const el=document.createElement('div');
      el.className='ch-item'+(c.id===S.chId?' active':'');
      el.dataset.chid = c.id;
      el.innerHTML=`<span class="ch-icon">#</span><span class="ch-name">${c.name}</span>`;
      el.onclick=()=>{S.chId=c.id;renderAll();autoSave()};
      // Right-click context menu
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        openChannelCtx(e, c.id);
      });
      body.appendChild(el);
    });
  }
}

/* ─── DM CONTEXT MENU ─── */
let ctxDmId = null;

function openDMCtx(e, dmId) {
  ctxDmId = dmId;
  const m = document.getElementById('ctx-dm');
  const isPinned = S.pinnedDMs.includes(dmId);
  document.getElementById('ctx-dm-pin').innerHTML = isPinned
  ? '<span class="ctx-ico">📌</span>Unpin DM'
  : '<span class="ctx-ico">📌</span>Pin DM';
  m.style.display = 'block';
  let x = e.clientX, y = e.clientY;
  requestAnimationFrame(() => {
    const mw = m.offsetWidth, mh = m.offsetHeight;
    if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
    if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
    m.style.left = x + 'px';
    m.style.top = y + 'px';
  });
}

function closeDMCtx() {
  document.getElementById('ctx-dm').style.display = 'none';
  ctxDmId = null;
}

document.getElementById('ctx-dm-pin').onclick = () => {
  if (ctxDmId === null) return;
  const idx = S.pinnedDMs.indexOf(ctxDmId);
  if (idx > -1) {
    S.pinnedDMs.splice(idx, 1);
  } else {
    S.pinnedDMs.push(ctxDmId);
  }
  closeDMCtx();
  renderSidebar();
  autoSave();
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctx-dm')) closeDMCtx();
});

function renderHeader(){
  const c=ch(); if(!c) return;
  const isDM=c.type==='dm';
  document.getElementById('hd-icon').textContent=isDM?'💬':'#';
  document.getElementById('hd-name').textContent=c.name;
  document.getElementById('hd-desc').textContent=isDM?`DM with ${c.name}`:(c.desc||'');
  document.getElementById('msg-input').placeholder=isDM?`Message ${c.name}…`:`Message #${c.name}…`;

  // Members button: servers only
  document.getElementById('btn-members').style.display = (S.view === 'server') ? '' : 'none';
  // Update friend request badge
  updateFriendBadge();
}

function renderBg(){
  const c=ch(); if(!c) return;
  const bg=c.bg||srv().defChBg||'';
  const layer=document.getElementById('bg-layer');
  if(bg){layer.style.backgroundImage=`url(${bg})`;layer.classList.add('has-img')}
  else{layer.style.backgroundImage='none';layer.classList.remove('has-img')}
}

let lastRenderedChId = null;
const _loadedChannels = new Set();
let _fetchingChannel = null;

async function renderMsgs(){
  const c=ch(); if(!c) return;
  const wrap=document.getElementById('messages-wrap');
  const currentChId = S.chId;
  
  // IMMEDIATELY clear on channel switch
  if(lastRenderedChId !== currentChId) {
    wrap.innerHTML = '';
    lastRenderedChId = currentChId;
  }
  
  // Show cached messages right away (before fetch)
  if(c.msgs && c.msgs.length > 0 && wrap.children.length === 0) {
    c.msgs.forEach(m => {
      wrap.appendChild(createMsgRow(m));
    });
    wrap.scrollTop = wrap.scrollHeight;
  }
  
  // Decide if we need to fetch from API
  const shouldFetch = typeof c.id === 'number' && !_loadedChannels.has(c.id);
  if (!shouldFetch) return;
  
  // Prevent double-fetching same channel
  if (_fetchingChannel === c.id) return;
  _fetchingChannel = c.id;
  
  try {
    const endpoint = c.type === 'dm'
    ? `/dms/${c.id}/messages`
    : `/channels/${c.id}/messages`;
    
    const messages = await api(endpoint);
    
    // Bail if user switched away during fetch
    if (S.chId !== currentChId) {
      _fetchingChannel = null;
      return;
    }
    
    _loadedChannels.add(c.id);
    
    messages.forEach(m => {
      upsertUser({
        id: m.user_id,
        name: m.display_name || m.username,
        color: m.color,
        accent: m.accent,
        avatar: m.avatar
      });
    });
    
    c.msgs = messages.map(m => ({
      id: m.id,
      uid: m.user_id === S.me.id ? 'me' : m.user_id,
      text: m.text || '',
      img: m.image || null,
      reply: m.reply_to,
      time: new Date(m.created_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
                                edited: m.edited,
                                reactions: m.reactions || {},
                                username: m.username,
                                userColor: m.color || '#58a6ff'
    }));
    
    // Bail again if switched away
    if (S.chId !== currentChId) {
      _fetchingChannel = null;
      return;
    }
    
    // Re-render with fresh data
    wrap.innerHTML = '';
    c.msgs.forEach(m => {
      wrap.appendChild(createMsgRow(m));
    });
    wrap.scrollTop = wrap.scrollHeight;
    
  } catch (err) {
    console.error('Failed to load messages:', err);
  } finally {
    _fetchingChannel = null;
  }
}

  // If we switched channels, clear everything and do full render
  if(lastRenderedChId !== S.chId) {
    wrap.innerHTML = '';
    lastRenderedChId = S.chId;

    if(c.msgs && c.msgs.length > 0) {
      c.msgs.forEach(m => {
        const row = createMsgRow(m);
        wrap.appendChild(row);
      });
    }
    wrap.scrollTop = wrap.scrollHeight;
    return;
  }

  // Same channel - only add new messages
  const existingIds = new Set(
    Array.from(wrap.querySelectorAll('.msg-row[data-id]'))
    .map(el => el.dataset.id).filter(Boolean)
  );

  const newMessages = c.msgs.filter(m => !existingIds.has(String(m.id)));

  // Append only new messages with animation
  newMessages.forEach(m => {
    const row = createMsgRow(m);
    row.style.opacity = '0';
    row.style.transform = 'translateY(20px)';
    wrap.appendChild(row);

    requestAnimationFrame(() => {
      row.style.opacity = '1';
      row.style.transform = 'translateY(0)';
    });
  });

  // Auto-scroll if user is near bottom
  if(wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 150) {
    wrap.scrollTop = wrap.scrollHeight;
  }
}

function createMsgRow(m, prevMsg) {
  const c = ch();
  const isMe = m.uid === 'me';
  const u = U(m.uid);

  if(m.sys) {
    const d = document.createElement('div');
    d.className = 'sys-msg';
    d.textContent = m.text;
    return d;
  }

  // Grouping: same user, within 5 minutes, no reply, prev wasn't system
  let grouped = false;
  if (prevMsg && !prevMsg.sys && prevMsg.uid === m.uid && !m.reply && m.rawTime && prevMsg.rawTime) {
    const diff = new Date(m.rawTime) - new Date(prevMsg.rawTime);
    if (diff < 300000 && diff >= 0) grouped = true;
  }

  let rpHTML = '';
  if(m.reply) {
    const rm = c.msgs.find(x => x.id === m.reply);
    if(rm && !rm.sys) {
      const ru = U(rm.uid);
      rpHTML = `<div class="reply-pre" data-scroll="${rm.id}">↩ <strong>${ru.name}</strong> ${(rm.text||'').substring(0,40)}${(rm.text||'').length > 40 ? '…' : ''}</div>`;
    }
  }

  // Build reactions HTML
  let reactHTML = '';
  if(m.reactions && Object.keys(m.reactions).length > 0) {
    reactHTML = '<div class="msg-reactions">';
    for(const emoji in m.reactions) {
      const users = m.reactions[emoji];
      const isMine = users.includes('me');
      reactHTML += `<div class="msg-react${isMine ? ' mine' : ''}" data-emoji="${emoji}" data-msgid="${m.id}">
      <span>${emoji}</span>
      <span class="msg-react-count">${users.length}</span>
      </div>`;
    }
    reactHTML += '</div>';
  }

  const row = document.createElement('div');
  row.className = 'msg-row';
  row.dataset.id = m.id;
  row.dataset.uid = m.uid;
  row.innerHTML = `
  <div class="msg-av" data-uid="${m.uid}">${avHTML(u,34)}</div>
  <div class="msg-body">
  ${rpHTML}
  <div class="msg-hd">
  <span class="msg-name" style="color:${u.color}" data-uid="${m.uid}">${u.name}</span>
  <span class="msg-time">${m.time}</span>
  ${m.edited ? '<span class="msg-edited">(edited)</span>' : ''}
  </div>
  <div class="msg-text">${linkify(m.text)}</div>
  ${m.img ? `<img class="msg-img" src="${m.img}" alt="">` : ''}
  ${reactHTML}
  </div>`;

  // RIGHT-CLICK → context menu
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    openCtx(e, m.id, isMe);
  });

  return row;
}

function renderAll(){
  const theme = getCurrentTheme();
  applyTheme(theme);
  renderRail();
  renderSidebar();
  renderHeader();
  renderBg();
  // Clear old messages immediately before async fetch starts
  const wrap = document.getElementById('messages-wrap');
  if(lastRenderedChId !== S.chId) {
    wrap.innerHTML = '';
    lastRenderedChId = S.chId;
  }
  renderMsgs();
}

/* ─── SEARCH ─── */
document.getElementById('btn-search').onclick = toggleSearch;
document.getElementById('search-window-close').onclick = toggleSearch;
document.addEventListener('keydown', e => {
  if(e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    toggleSearch();
  }
  if(e.key === 'Escape' && S.searchActive) {
    toggleSearch();
  }
});

function toggleSearch() {
  S.searchActive = !S.searchActive;
  const win = document.getElementById('search-window');
  const input = document.getElementById('search-window-input');

  if(S.searchActive) {
    win.classList.add('show');
    input.focus();
  } else {
    win.classList.remove('show');
    input.value = '';
    document.getElementById('search-results-area').innerHTML = '';
  }
}

document.getElementById('search-window-input').addEventListener('input', e => {
  const query = e.target.value.toLowerCase().trim();
  const c = ch();
  const resultsArea = document.getElementById('search-results-area');

  if(!c) return;

  if(!query) {
    resultsArea.innerHTML = '';
    return;
  }

  const matches = c.msgs.filter(m =>
  !m.sys && m.text && m.text.toLowerCase().includes(query)
  );

  if(matches.length === 0) {
    resultsArea.innerHTML = '<div class="search-no-results">No messages found</div>';
    return;
  }

  resultsArea.innerHTML = '';
  matches.forEach(m => {
    const u = U(m.uid);
    const item = document.createElement('div');
    item.className = 'search-result-item';

    // Highlight the query in the text
    const text = m.text.replace(
      new RegExp(`(${query})`, 'gi'),
                                '<mark>$1</mark>'
    );

    item.innerHTML = `
    <div class="search-result-user" style="color:${u.color}">${u.name} <span style="color:var(--dim);font-weight:400;font-size:11px">${m.time}</span></div>
    <div class="search-result-text">${text}</div>
    `;

    item.onclick = () => {
      const msgRow = document.querySelector(`.msg-row[data-id="${m.id}"]`);
      if(msgRow) {
        msgRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        msgRow.classList.add('highlight');
        setTimeout(() => msgRow.classList.remove('highlight'), 2000);
      }
      toggleSearch();
    };

    resultsArea.appendChild(item);
  });
});

/* ─── CONTEXT MENU ─── */
function openCtx(e,id,isMe){
  S.ctxId=id;
  const m=document.getElementById('ctx-menu');
  document.getElementById('ctx-edit').style.display=isMe?'flex':'none';
  document.getElementById('ctx-delete').style.display=isMe?'flex':'none';
  document.getElementById('ctx-sep').style.display=isMe?'block':'none';
  m.style.display='block';
  let x=e.clientX,y=e.clientY;
  // keep in viewport
  requestAnimationFrame(()=>{
    const mw=m.offsetWidth,mh=m.offsetHeight;
    if(x+mw>window.innerWidth)x=window.innerWidth-mw-8;
    if(y+mh>window.innerHeight)y=window.innerHeight-mh-8;
    m.style.left=x+'px';m.style.top=y+'px';
  });
}
function closeCtx(){
  document.getElementById('ctx-menu').style.display='none';
  S.ctxId=null;
}

function openChannelCtx(e, chId) {
  S.ctxChId = chId;
  const m = document.getElementById('ctx-channel');
  m.style.display = 'block';
  let x = e.clientX, y = e.clientY;

  requestAnimationFrame(() => {
    const mw = m.offsetWidth, mh = m.offsetHeight;
    if(x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
    if(y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
    m.style.left = x + 'px';
    m.style.top = y + 'px';
  });
}

function closeChannelCtx() {
  document.getElementById('ctx-channel').style.display = 'none';
  S.ctxChId = null;
}

document.getElementById('ctx-reply').onclick =()=>{if(S.ctxId!==null)startReply(S.ctxId);closeCtx()};
document.getElementById('ctx-copy').onclick  =()=>{
  if(S.ctxId!==null){
    const c=ch();const m=c.msgs.find(x=>x.id===S.ctxId);
    if(m&&m.text)navigator.clipboard.writeText(m.text);
  }
  closeCtx();
};
document.getElementById('ctx-edit').onclick  =()=>{if(S.ctxId!==null)editMsg(S.ctxId);closeCtx()};
document.getElementById('ctx-delete').onclick=()=>{if(S.ctxId!==null)deleteMsg(S.ctxId);closeCtx()};
document.getElementById('ctx-react').onclick =()=>{if(S.ctxId!==null)reactToMsg(S.ctxId);closeCtx()};

document.getElementById('ctx-ch-edit').onclick = () => {
  if(S.ctxChId) {
    const c = srv().channels.find(ch => ch.id === S.ctxChId);
    if(c) {
      S.editingChannelId = S.ctxChId;
      document.getElementById('ec-name').value = c.name;
      document.getElementById('ec-desc').value = c.desc;
      openM('m-editchannel');
    }
  }
  closeChannelCtx();
};

document.getElementById('ctx-ch-delete').onclick = () => {
  if(S.ctxChId && confirm('Delete this channel?')) {
    const s = srv();
    const idx = s.channels.findIndex(c => c.id === S.ctxChId);
    if(idx > -1) {
      s.channels.splice(idx, 1);
      if(S.chId === S.ctxChId) {
        S.chId = s.channels[0].id;
      }
      renderAll();
      autoSave();
    }
  }
  closeChannelCtx();
};

document.addEventListener('click',(e)=>{
  if(!e.target.closest('#ctx-menu'))closeCtx();
  if(!e.target.closest('#ctx-channel'))closeChannelCtx();
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeCtx();closeChannelCtx();closePC()}});

/* ─── PROFILE CARD ─── */
async function showPC(e,uid){
  e.stopPropagation();

  // Close any open modals (like members list)
  document.querySelectorAll('.ov.show').forEach(m => m.classList.remove('show'));

  // Parse string IDs to numbers (dataset attributes are always strings)
  if (uid !== 'me' && !isNaN(uid)) uid = Number(uid);

  const u=U(uid);
  const card=document.getElementById('profile-card');

  // Get user's colors (with fallbacks)
  const primary = u.color || '#58a6ff';
  const secondary = u.accent || '#3fb950';
  const gradient = `linear-gradient(135deg, ${primary}, ${secondary})`;

  // Darken the primary color for background
  const primaryDark = darkenColor(primary, 0.7);
  const primaryMid = darkenColor(primary, 0.5);

  // Set CSS custom properties for this user's theme
  card.style.setProperty('--pc-primary', primaryDark);
  card.style.setProperty('--pc-accent-fade', `${secondary}15`);
  card.style.setProperty('--pc-accent-glow', `${primary}12`);
  card.style.setProperty('--pc-secondary-glow', `${secondary}10`);
  card.style.background = primaryDark;
  card.style.border = `1px solid ${primary}30`;

  // Banner - use gradient if no image
  const banner = document.getElementById('pc-banner');
  if(u.banner) {
    banner.style.background = `url(${u.banner}) center/cover`;
  } else {
    banner.style.background = gradient;
  }

  document.getElementById('pc-av').innerHTML=avHTML(u,76);
  document.getElementById('pc-name').textContent=u.name;
  document.getElementById('pc-name').style.color=primary;
  document.getElementById('pc-bio').textContent=u.bio||'No bio yet';

  // Friend badge - managed by async status check below
  const friendBadge = document.getElementById('pc-friend');
  friendBadge.style.display='none';
  friendBadge.style.background = `${secondary}22`;
  friendBadge.style.color = secondary;

  // actions
  const act=document.getElementById('pc-actions');
  act.innerHTML='';

  if(uid === 'me') {
    // Edit Profile button for own profile
    const editB = document.createElement('button');
    editB.className = 'pc-btn pri';
    editB.style.background = gradient;
    editB.innerHTML = '✏️ Edit';
    editB.onclick = () => {
      closePC();
      document.getElementById('btn-profile').click();
    };
    act.appendChild(editB);

    // Gallery button
    const galB = document.createElement('button');
    galB.className = 'pc-btn gallery';
    galB.style.background = gradient;
    galB.innerHTML = '🖼️ Gallery';
    galB.onclick = () => {
      closePC();
      openGallery('me');
    };
    act.appendChild(galB);
  } else {
    // DM btn
    const dmB=document.createElement('button');
    dmB.className='pc-btn sec';
    dmB.innerHTML='💬 DM';
    dmB.onclick=()=>{
      const homeServer = S.servers.find(s => s.id === 'home');
      if(homeServer) {
        const d = homeServer.dms.find(x => x.userId === uid);
        if(d) {
          closePC();
          S.srvId = 'home';
          S.chId = d.id;
          S.view = 'dms';
          renderAll();
        }
      }
    };
    act.appendChild(dmB);

    // Friend btn - check real friendship status from API
    const frB=document.createElement('button');
    frB.className='pc-btn pend';
    frB.innerHTML='⏳ Loading...';
    frB.disabled=true;
    act.appendChild(frB);

    // Async check friendship status
    if (typeof uid === 'number') {
      (async () => {
        try {
          const statusData = await api(`/friends/status/${uid}`);
          if (statusData.status === 'accepted') {
            frB.className='pc-btn pend';
            frB.innerHTML='✓ Friends';
            frB.disabled=true;
            // Also show the friend badge
            friendBadge.style.display='inline';
          } else if (statusData.status === 'pending_sent') {
            frB.className='pc-btn pend';
            frB.innerHTML='⏳ Pending';
            frB.disabled=true;
            friendBadge.style.display='none';
          } else if (statusData.status === 'pending_received') {
            frB.className='pc-btn pri';
            frB.style.background = gradient;
            frB.innerHTML='✓ Accept';
            frB.disabled=false;
            frB.onclick=async()=>{
              frB.disabled=true;
              frB.innerHTML='Accepting...';
              await acceptFriendRequest(statusData.requestId, frB);
              frB.className='pc-btn pend';
              frB.innerHTML='✓ Friends';
              friendBadge.style.display='inline';
              updateFriendBadge();
            };
            friendBadge.style.display='none';
          } else {
            frB.className='pc-btn pri';
            frB.style.background = gradient;
            frB.innerHTML='+ Add';
            frB.disabled=false;
            frB.onclick=async()=>{
              frB.disabled=true;
              frB.innerHTML='Sending...';
              try {
                await sendFriendRequest(uid, frB);
                frB.className='pc-btn pend';
                frB.innerHTML='⏳ Pending';
              } catch(err) {
                frB.innerHTML='+ Add';
                frB.disabled=false;
              }
            };
            friendBadge.style.display='none';
          }
        } catch(err) {
          frB.className='pc-btn pri';
          frB.style.background = gradient;
          frB.innerHTML='+ Add';
          frB.disabled=false;
          friendBadge.style.display='none';
        }
      })();
    }

    // Gallery button for other users
    const galB = document.createElement('button');
    galB.className = 'pc-btn gallery';
    galB.style.background = gradient;
    galB.innerHTML = '🖼️ Gallery';
    galB.onclick = () => {
      closePC();
      openGallery(uid);
    };
    act.appendChild(galB);
  }

  // position
  card.style.display='block';
  const rect=e.target.getBoundingClientRect();
  requestAnimationFrame(()=>{
    let l=rect.left+rect.width+10, t=rect.top;
    const cw=card.offsetWidth,cht=card.offsetHeight;
    if(l+cw>window.innerWidth)l=rect.left-cw-10;
    if(t+cht>window.innerHeight)t=window.innerHeight-cht-10;
    if(t<0)t=10;
    card.style.left=l+'px';card.style.top=t+'px';
  });

  // Background refresh for other users
  if (uid !== 'me' && typeof uid === 'number') {
    fetchFullUser(uid).then(freshU => {
      if (card.style.display === 'block') {
        document.getElementById('pc-av').innerHTML = avHTML(freshU, 76);
        document.getElementById('pc-name').textContent = freshU.name;
        document.getElementById('pc-name').style.color = freshU.color || '#58a6ff';
        document.getElementById('pc-bio').textContent = freshU.bio || 'No bio yet';
        if (freshU.banner) document.getElementById('pc-banner').style.background = `url(${freshU.banner}) center/cover`;
      }
    });
  }
}

function updatePC(uid){
  const u=U(uid);
  // Friend badge is now managed by the async status check in showPC
}

function closePC(){document.getElementById('profile-card').style.display='none'}

// delegated clicks for avatars & names in chat
document.getElementById('messages-wrap').addEventListener('click',e=>{
  const av=e.target.closest('.msg-av[data-uid]');
  if(av){showPC(e,av.dataset.uid);return}
  const nm=e.target.closest('.msg-name[data-uid]');
  if(nm){showPC(e,nm.dataset.uid);return}
  const rp=e.target.closest('.reply-pre[data-scroll]');
  if(rp){const t=document.querySelector(`[data-id="${rp.dataset.scroll}"]`);if(t)t.scrollIntoView({behavior:'smooth',block:'center'});return}

  // Handle reaction click (toggle)
  const react=e.target.closest('.msg-react[data-msgid]');
  if(react){
    const msgId=Number(react.dataset.msgid);
    const emoji=react.dataset.emoji;
    const c=ch();
    const m=c.msgs.find(x=>x.id===msgId);
    if(m && m.reactions && m.reactions[emoji]){
      const idx=m.reactions[emoji].indexOf('me');
      if(idx>-1){
        m.reactions[emoji].splice(idx,1);
        if(m.reactions[emoji].length===0) delete m.reactions[emoji];
      } else {
        m.reactions[emoji].push('me');
      }
      // Update just this message row
      const row=document.querySelector(`.msg-row[data-id="${msgId}"]`);
      if(row){
        const newRow=createMsgRow(m);
        row.replaceWith(newRow);
      }
    }
    return;
  }
});

// close card on outside click
document.addEventListener('click',e=>{
  if(!e.target.closest('#profile-card')&&!e.target.closest('.msg-av')&&!e.target.closest('.msg-name')&&!e.target.closest('.mem-av')&&!e.target.closest('.mem-name'))closePC();
});

/* ─── MESSAGING ─── */
async function send() {
  const inp = document.getElementById('msg-input');
  const text = inp.value.trim();
  const c = ch();
  if (!c) return;
  if (!text && !S.pendingImg) return;

  // Clear input immediately
  inp.value = '';
  const tempImg = S.pendingImg;
  const tempReply = S.replyTo;
  S.pendingImg = null;
  cancelReply();
  document.getElementById('btn-attach').classList.remove('has');

  // Determine if this is a DM - handle both string IDs (old) and numeric IDs (database)
  const isDM = c.type === 'dm';
  const channelId = isDM ? null : c.id;

  // For DMs, use the numeric ID if it exists, otherwise don't send
  const dmChannelId = isDM ? (typeof c.id === 'number' ? c.id : null) : null;

  if (isDM && !dmChannelId) {
    console.error('Cannot send DM - not a database DM channel');
    return;
  }

  // If it's a real channel (from database), send via WebSocket
  if (c.type === 'ch' && typeof c.id === 'number') {
    // Optimistic render
    c.msgs.push({
      id: '_tmp_' + Date.now(), uid: 'me', text, img: tempImg,
                reply: tempReply, time: T(), edited: false, reactions: {}, _temp: true
    });
    renderMsgs();
    sendMessageViaWebSocket(channelId, text, tempImg, tempReply, false, null);
  } else if (isDM) {
    // Optimistic render
    c.msgs.push({
      id: '_tmp_' + Date.now(), uid: 'me', text, img: tempImg,
                reply: tempReply, time: T(), edited: false, reactions: {}, _temp: true
    });
    renderMsgs();
    sendMessageViaWebSocket(null, text, tempImg, tempReply, true, dmChannelId);
    S.dmLastActivity[dmChannelId] = new Date().toISOString();
    renderSidebar();
  } else {
    // Local-only (demo channels)
    c.msgs.push({
      id: Date.now(),
                uid: 'me',
                text,
                img: tempImg,
                reply: tempReply,
                time: T(),
                edited: false,
                reactions: {}
    });
    renderMsgs();
  }

  autoSave();
}

// Wire up send button and input
document.getElementById('btn-send').onclick = () => send();
document.getElementById('msg-input').addEventListener('keydown', e => {
  if(e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

document.getElementById('btn-attach').onclick = () => document.getElementById('file-input').click();
document.getElementById('file-input').onchange = async e => {
  const f = e.target.files[0];
  if(!f) return;
  S.pendingImg = await readF(f);
  e.target.value = '';
  document.getElementById('btn-attach').classList.add('has');
};

function startReply(id){
  S.replyTo=id;
  const c=ch(); const m=c.msgs.find(x=>x.id===id); if(!m) return;
  document.getElementById('reply-label').textContent=`Replying to ${U(m.uid).name}: ${(m.text||'').substring(0,40)}`;
  document.getElementById('reply-bar').classList.add('show');
}

function cancelReply(){
  S.replyTo=null;
  document.getElementById('reply-bar').classList.remove('show');
}

document.getElementById('btn-cancel-reply').onclick=cancelReply;

function editMsg(id){
  const c=ch();const m=c.msgs.find(x=>x.id===id);if(!m)return;
  const t=prompt('Edit:',m.text);
  if(t!==null&&t.trim()){
    m.text=t.trim();
    m.edited=true;
    const row = document.querySelector(`.msg-row[data-id="${id}"]`);
    if(row) {
      const newRow = createMsgRow(m);
      row.replaceWith(newRow);
    }
    // Persist edit via WebSocket
    if(typeof id === 'number') {
      const isDM = c.type === 'dm';
      editMessageViaWebSocket(id, m.text, isDM, isDM ? null : c.id, isDM ? c.id : null);
    }
    autoSave();
  }
}

function reactToMsg(id){
  const emojis=['👍','❤️','😂','🔥','😮','🎉','💯','😢'];
  const c=ch();const m=c.msgs.find(x=>x.id===id);if(!m)return;
  const pick=prompt('React with emoji:\n'+emojis.join(' ')+'\n\nOr type any emoji:');
  if(!pick||!pick.trim())return;
  const emoji=pick.trim();
  if(!m.reactions)m.reactions={};
  if(!m.reactions[emoji])m.reactions[emoji]=[];
  const idx=m.reactions[emoji].indexOf('me');
  if(idx>-1){m.reactions[emoji].splice(idx,1);if(m.reactions[emoji].length===0)delete m.reactions[emoji];}
  else{m.reactions[emoji].push('me');}
  const row=document.querySelector(`.msg-row[data-id="${id}"]`);
  if(row){const newRow=createMsgRow(m);row.replaceWith(newRow);}
  autoSave();
}

/* ─── MODAL SYSTEM ─── */
function openM(id){
  document.getElementById(id).classList.add('show');
}

function closeM(id){
  document.getElementById(id).classList.remove('show');
}

// Wire all modal close buttons (X buttons and Cancel buttons with data-close)
document.querySelectorAll('[data-close]').forEach(btn=>{
  btn.onclick=()=>{
    const modalId = btn.dataset.close;
    closeM(modalId);
    if(btn.dataset.close === 'm-profile') closeM('m-profile-preview'); // ADD THIS
    if(modalId === 'm-profile') closeM('m-profile-preview');
    if(modalId === 'm-ui') closeM('m-ui-preview');
    if(modalId === 'm-srv') closeM('m-srv-preview');
  };
});

/* ─── UPLOAD PREVIEW ─── */
function setPreview(boxId, src){
  const box=document.getElementById(boxId);
  if(!box) return;
  const ph=box.querySelector('.ph');
  const existing=box.querySelector('img');
  if(existing) existing.remove();
  if(src){
    const img=document.createElement('img');
    img.src=src;
    box.appendChild(img);
    if(ph) ph.style.display='none';
  } else {
    if(ph) ph.style.display='';
  }
}

/* ─── DELETE MESSAGE ─── */
function deleteMsg(id){
  if(!confirm('Delete this message?')) return;
  const c=ch();
  const idx=c.msgs.findIndex(m=>m.id===id);
  if(idx>-1){
    if(typeof id === 'number'){
      api(`/messages/${id}`,{method:'DELETE'}).catch(err=>console.error('Delete failed:',err));
    }
    c.msgs.splice(idx,1);
    const row=document.querySelector(`.msg-row[data-id="${id}"]`);
    if(row) row.remove();
    autoSave();
  }
}

/* ─── EDIT CHANNEL SAVE ─── */
document.getElementById('btn-save-editchannel').onclick=async()=>{
  if(!S.editingChannelId) return;
  const s=srv();
  const c=s.channels.find(ch=>ch.id===S.editingChannelId);
  if(!c) return;
  const newName=document.getElementById('ec-name').value.trim();
  const newDesc=document.getElementById('ec-desc').value.trim();
  if(newName) c.name=newName;
  c.desc=newDesc;
  if(typeof c.id==='number'){
    try{
      await api(`/servers/${S.srvId}/channels/${c.id}`,{
        method:'PUT',
        body:{name:c.name,description:c.desc}
      });
    }catch(err){console.error('Edit channel failed:',err)}
  }
  S.editingChannelId=null;
  closeM('m-editchannel');
  renderAll();
  autoSave();
};

// Replace existing listeners with:
document.getElementById('p-bio').addEventListener('input', () => {
  const bio = document.getElementById('p-bio').value;
  const counter = document.getElementById('bio-counter');
  if(counter) counter.textContent = `${bio.length}/50`;
  updateProfilePreview(); // ADD THIS
});

['p-color','p-accent'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    const c = document.getElementById('p-color').value;
    const a = document.getElementById('p-accent').value;
    const prev = document.getElementById('profile-grad-preview');
    if(prev) prev.style.background = `linear-gradient(135deg, ${c}, ${a})`;
    updateProfilePreview(); // ADD THIS
  });
});

// ADD THIS NEW LISTENER for name changes
document.getElementById('p-name').addEventListener('input', updateProfilePreview);

// ADD THIS NEW LISTENER for avatar/banner uploads
['ub-avatar', 'ub-banner'].forEach(id => {
  document.getElementById(id).querySelector('input').addEventListener('change', updateProfilePreview);
});

document.getElementById('btn-save-prof').onclick = async ()=>{
  S.me.name = document.getElementById('p-name').value.trim() || S.me.name;
  S.me.bio = document.getElementById('p-bio').value.trim();
  S.me.color = document.getElementById('p-color').value;
  S.me.accent = document.getElementById('p-accent').value;

  const af = document.getElementById('ub-avatar').querySelector('input').files[0];
  if(af) S.me.avatar = await readF(af);

  const bf = document.getElementById('ub-banner').querySelector('input').files[0];
  if(bf) S.me.banner = await readF(bf);

  closeM('m-profile');
  closeM('m-profile-preview');
  renderAll();
  autoSave();
  syncProfileToServer();
};

// Live updates for profile modal
document.getElementById('p-bio').addEventListener('input', () => {
  const bio = document.getElementById('p-bio').value;
  const counter = document.getElementById('bio-counter');
  if(counter) counter.textContent = `${bio.length}/50`;
});

['p-color','p-accent'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    const c = document.getElementById('p-color').value;
    const a = document.getElementById('p-accent').value;
    const prev = document.getElementById('profile-grad-preview');
    if(prev) prev.style.background = `linear-gradient(135deg, ${c}, ${a})`;
  });
});

/* ─── UI SETTINGS ─── */
document.getElementById('btn-ui').onclick=openUISettings;

function openUISettings(){
  const t=S.personalUI;
  document.getElementById('ui-override').checked = t.override;
  document.getElementById('ui-bg').value    =t.bg;
  document.getElementById('ui-surf').value  =t.surface;
  document.getElementById('ui-acc1').value  =t.acc1;
  document.getElementById('ui-acc2').value  =t.acc2;
  document.getElementById('ui-text').value  =t.text;
  document.getElementById('ui-border').value=t.border;
  document.getElementById('ui-sidebar-style').value=t.sidebarStyle;
  document.getElementById('ui-sb-grad1').value=t.sidebarGrad1;
  document.getElementById('ui-sb-grad2').value=t.sidebarGrad2;

  const opacity = t.sidebarOpacity !== undefined ? t.sidebarOpacity : 1;
  const blur = t.sidebarBlur !== undefined ? t.sidebarBlur : 10;
  document.getElementById('ui-sidebar-opacity').value = opacity * 100;
  document.getElementById('ui-sidebar-blur').value = blur;
  document.getElementById('ui-opacity-val').textContent = Math.round(opacity * 100) + '%';
  document.getElementById('ui-blur-val').textContent = blur + 'px';
  const bgMode = t.sidebarBgMode || 'color';
  document.getElementById('ui-sidebar-bg-mode').value = bgMode;

  document.getElementById('ui-grad-swatch').style.background=`linear-gradient(135deg,${t.acc1},${t.acc2})`;
  document.getElementById('ui-sidebar-grad-swatch').style.background=`linear-gradient(135deg,${t.sidebarGrad1},${t.sidebarGrad2})`;

  toggleUISidebarGradControls();
  openM('m-ui');
  openM('m-ui-preview');
  updateUIPreview();
}

function updateUIPreview() {
  const bg = document.getElementById('ui-bg').value;
  const surf = document.getElementById('ui-surf').value;
  const acc1 = document.getElementById('ui-acc1').value;
  const acc2 = document.getElementById('ui-acc2').value;
  const text = document.getElementById('ui-text').value;
  const border = document.getElementById('ui-border').value;
  const sidebarStyle = document.getElementById('ui-sidebar-style').value;
  const sbGrad1 = document.getElementById('ui-sb-grad1').value;
  const sbGrad2 = document.getElementById('ui-sb-grad2').value;
  const opacity = document.getElementById('ui-sidebar-opacity').value / 100;
  const blur = document.getElementById('ui-sidebar-blur').value;

  const sample = document.getElementById('preview-ui-sample');
  const sidebar = document.getElementById('preview-ui-sidebar');
  const main = document.getElementById('preview-ui-main');
  const header = document.getElementById('preview-ui-header');
  const content = document.getElementById('preview-ui-content');
  const input = document.getElementById('preview-ui-input');
  const avatar = document.getElementById('preview-ui-avatar');

  // Apply colors
  sample.style.background = bg;
  sample.style.color = text;
  sample.style.borderColor = border;

  if(sidebarStyle === 'gradient') {
    const grad1 = hexToRgba(sbGrad1, opacity);
    const grad2 = hexToRgba(sbGrad2, opacity);
    sidebar.style.background = `linear-gradient(180deg, ${grad1}, ${grad2})`;
  } else {
    sidebar.style.backgroundColor = hexToRgba(surf, opacity);
  }
  sidebar.style.backdropFilter = `blur(${blur}px)`;
  sidebar.style.webkitBackdropFilter = `blur(${blur}px)`;
  sidebar.style.color = text;

  main.style.background = bg;
  main.style.color = text;

  header.style.background = `rgba(${hexToRgb(surf)}, 0.8)`;
  header.style.borderBottomColor = border;
  header.style.color = text;

  content.style.color = text;

  input.style.background = `rgba(${hexToRgb(surf)}, 0.8)`;
  input.style.borderTopColor = border;
  input.querySelector('div').style.background = surf;
  input.querySelector('div').style.borderColor = border;
  input.querySelector('div').style.color = text;

  avatar.style.background = `linear-gradient(135deg, ${acc1}, ${acc2})`;
}

function toggleUISidebarGradControls() {
  const style = document.getElementById('ui-sidebar-style').value;
  const controls = document.getElementById('ui-sidebar-grad-controls');
  controls.style.display = style === 'gradient' ? 'block' : 'none';
}

document.getElementById('ui-sidebar-style').addEventListener('change', toggleUISidebarGradControls);

// live updates
['ui-bg','ui-surf','ui-acc1','ui-acc2','ui-text','ui-border'].forEach(id=>{
  document.getElementById(id).addEventListener('input',()=>{
    S.personalUI.bg     =document.getElementById('ui-bg').value;
    S.personalUI.surface=document.getElementById('ui-surf').value;
    S.personalUI.acc1   =document.getElementById('ui-acc1').value;
    S.personalUI.acc2   =document.getElementById('ui-acc2').value;
    S.personalUI.text   =document.getElementById('ui-text').value;
    S.personalUI.border =document.getElementById('ui-border').value;
    if(S.view === 'dms' || S.personalUI.override) {
      applyTheme(S.personalUI);
    }
    document.getElementById('ui-grad-swatch').style.background=`linear-gradient(135deg,${S.personalUI.acc1},${S.personalUI.acc2})`;
    updateUIPreview();
  });
});

['ui-sb-grad1','ui-sb-grad2'].forEach(id=>{
  document.getElementById(id).addEventListener('input',()=>{
    S.personalUI.sidebarGrad1 = document.getElementById('ui-sb-grad1').value;
    S.personalUI.sidebarGrad2 = document.getElementById('ui-sb-grad2').value;
    document.getElementById('ui-sidebar-grad-swatch').style.background=`linear-gradient(135deg,${S.personalUI.sidebarGrad1},${S.personalUI.sidebarGrad2})`;
    if((S.view === 'dms' || S.personalUI.override) && S.personalUI.sidebarStyle === 'gradient') {
      applyTheme(S.personalUI);
    }
    updateUIPreview();
  });
});

document.getElementById('ui-sidebar-opacity').addEventListener('input', (e) => {
  const val = e.target.value / 100;
  S.personalUI.sidebarOpacity = val;
  document.getElementById('ui-opacity-val').textContent = Math.round(val * 100) + '%';
  if(S.view === 'dms' || S.personalUI.override) {
    applyTheme(S.personalUI);
  }
  updateUIPreview();
});

document.getElementById('ui-sidebar-blur').addEventListener('input', (e) => {
  const val = e.target.value;
  S.personalUI.sidebarBlur = Number(val);
  document.getElementById('ui-blur-val').textContent = val + 'px';
  if(S.view === 'dms' || S.personalUI.override) {
    applyTheme(S.personalUI);
  }
  updateUIPreview();
});

document.getElementById('ui-sidebar-bg-mode').addEventListener('change', (e) => {
  S.personalUI.sidebarBgMode = e.target.value;
  if(S.view === 'dms' || S.personalUI.override) {
    applyTheme(S.personalUI);
  }
  updateUIPreview();
});

document.getElementById('btn-save-ui').onclick=()=>{
  S.personalUI.override = document.getElementById('ui-override').checked;
  S.personalUI.sidebarStyle = document.getElementById('ui-sidebar-style').value;
  closeM('m-ui');
  closeM('m-ui-preview');
  renderAll();
  autoSave();
  syncSettingsToServer();
};

document.getElementById('btn-reset-ui').onclick=()=>{
  S.personalUI={
    override:false,
    bg:'#0d1117',
    surface:'#161b22',
    acc1:'#58a6ff',
    acc2:'#3fb950',
    text:'#c9d1d9',
    border:'#30363d',
    sidebarStyle:'solid',
    sidebarGrad1:'#161b22',
    sidebarGrad2:'#1c2333',
    sidebarOpacity:1,
    sidebarBlur:10,
    sidebarBgMode:'color'
  };
  renderAll();
  openUISettings();
  updateUIPreview();
  autoSave();
  syncSettingsToServer();
};

/* ─── SERVER SETTINGS ─── */
document.getElementById('btn-srv-set').onclick=()=>{
  const s=srv();if(!s.isAdmin)return;
  const a = s.aesthetics;

  document.getElementById('s-name').value  =s.name;
  document.getElementById('s-bg').value    =a.bg;
  document.getElementById('s-surf').value  =a.surface;
  document.getElementById('s-acc1').value  =a.acc1;
  document.getElementById('s-acc2').value  =a.acc2;
  document.getElementById('s-text').value  =a.text;
  document.getElementById('s-border').value=a.border;
  document.getElementById('s-sidebar-style').value=a.sidebarStyle;
  document.getElementById('s-sb-grad1').value=a.sidebarGrad1;
  document.getElementById('s-sb-grad2').value=a.sidebarGrad2;

  const sOpacity = a.sidebarOpacity !== undefined ? a.sidebarOpacity : 1;
  const sBlur = a.sidebarBlur !== undefined ? a.sidebarBlur : 10;
  const sBgMode = a.sidebarBgMode || 'color';

  document.getElementById('s-sidebar-opacity').value = sOpacity * 100;
  document.getElementById('s-sidebar-blur').value = sBlur;
  document.getElementById('s-sidebar-bg-mode').value = sBgMode;
  document.getElementById('s-opacity-val').textContent = Math.round(sOpacity * 100) + '%';
  document.getElementById('s-blur-val').textContent = sBlur + 'px';

  document.getElementById('s-grad-swatch').style.background=`linear-gradient(135deg,${a.acc1},${a.acc2})`;
  document.getElementById('s-sidebar-grad-swatch').style.background=`linear-gradient(135deg,${a.sidebarGrad1},${a.sidebarGrad2})`;

  setPreview('ub-srv-icon',s.iconImg||'');
  setPreview('ub-srv-ban',s.banner||'');
  setPreview('ub-srv-chbg',s.defChBg||'');

  toggleServerSidebarGradControls();
  openM('m-srv');
  openM('m-srv-preview');
  updateServerPreview();
};

function toggleServerSidebarGradControls() {
  const style = document.getElementById('s-sidebar-style').value;
  const controls = document.getElementById('s-sidebar-grad-controls');
  controls.style.display = style === 'gradient' ? 'block' : 'none';
}

document.getElementById('s-sidebar-style').addEventListener('change', toggleServerSidebarGradControls);

// ADD name listener:
document.getElementById('s-name').addEventListener('input', updateServerPreview);

// live updates for server aesthetics
['s-bg','s-surf','s-acc1','s-acc2','s-text','s-border'].forEach(id=>{
  document.getElementById(id).addEventListener('input',()=>{
    const s = srv();
    s.aesthetics.bg     =document.getElementById('s-bg').value;
    s.aesthetics.surface=document.getElementById('s-surf').value;
    s.aesthetics.acc1   =document.getElementById('s-acc1').value;
    s.aesthetics.acc2   =document.getElementById('s-acc2').value;
    s.aesthetics.text   =document.getElementById('s-text').value;
    s.aesthetics.border =document.getElementById('s-border').value;
    if(S.view === 'server' && !S.personalUI.override) {
      applyTheme(s.aesthetics);
    }
    document.getElementById('s-grad-swatch').style.background=`linear-gradient(135deg,${s.aesthetics.acc1},${s.aesthetics.acc2})`;
    updateServerPreview();
  });
});

['s-sb-grad1','s-sb-grad2'].forEach(id=>{
  document.getElementById(id).addEventListener('input',()=>{
    const s = srv();
    s.aesthetics.sidebarGrad1 = document.getElementById('s-sb-grad1').value;
    s.aesthetics.sidebarGrad2 = document.getElementById('s-sb-grad2').value;
    document.getElementById('s-sidebar-grad-swatch').style.background=`linear-gradient(135deg,${s.aesthetics.sidebarGrad1},${s.aesthetics.sidebarGrad2})`;
    if(S.view === 'server' && !S.personalUI.override && s.aesthetics.sidebarStyle === 'gradient') {
      applyTheme(s.aesthetics);
    }
    updateServerPreview();
  });
});

document.getElementById('s-sidebar-opacity').addEventListener('input', (e) => {
  const val = e.target.value / 100;
  srv().aesthetics.sidebarOpacity = val;
  document.getElementById('s-opacity-val').textContent = Math.round(val * 100) + '%';
  if(S.view === 'server' && !S.personalUI.override) {
    applyTheme(srv().aesthetics);
  }
  updateServerPreview();
});

document.getElementById('s-sidebar-blur').addEventListener('input', (e) => {
  const val = e.target.value;
  srv().aesthetics.sidebarBlur = Number(val);
  document.getElementById('s-blur-val').textContent = val + 'px';
  if(S.view === 'server' && !S.personalUI.override) {
    applyTheme(srv().aesthetics);
  }
  updateServerPreview();
});

document.getElementById('s-sidebar-bg-mode').addEventListener('change', (e) => {
  srv().aesthetics.sidebarBgMode = e.target.value;
  if(S.view === 'server' && !S.personalUI.override) {
    applyTheme(srv().aesthetics);
  }
  updateServerPreview();
});

// ADD sidebar style listener:
document.getElementById('s-sidebar-style').addEventListener('change', () => {
  toggleServerSidebarGradControls();
  updateServerPreview();
});

// ADD file upload listeners:
['ub-srv-icon', 'ub-srv-ban', 'ub-srv-chbg'].forEach(id => {
  document.getElementById(id).querySelector('input').addEventListener('change', updateServerPreview);
});

document.getElementById('btn-save-srv').onclick=async()=>{
  const s=srv();
  s.name  =document.getElementById('s-name').value.trim()||s.name;
  s.aesthetics.sidebarStyle = document.getElementById('s-sidebar-style').value;
  s.aesthetics.sidebarOpacity = document.getElementById('s-sidebar-opacity').value / 100;
  s.aesthetics.sidebarBlur = Number(document.getElementById('s-sidebar-blur').value);
  s.aesthetics.sidebarBgMode = document.getElementById('s-sidebar-bg-mode').value;

  const iF=document.getElementById('ub-srv-icon').querySelector('input').files[0];
  if(iF) {
    try { s.iconImg = await uploadFileToS3(iF); } catch(e) { s.iconImg = await readF(iF); }
  }
  const bF=document.getElementById('ub-srv-ban').querySelector('input').files[0];
  if(bF) {
    try { s.banner = await uploadFileToS3(bF); } catch(e) { s.banner = await readF(bF); }
  }
  const cF=document.getElementById('ub-srv-chbg').querySelector('input').files[0];
  if(cF) {
    try { s.defChBg = await uploadFileToS3(cF); } catch(e) { s.defChBg = await readF(cF); }
  }

  // Broadcast to all members via WebSocket
  if(ws && ws.readyState === WebSocket.OPEN && typeof s.id === 'number') {
    ws.send(JSON.stringify({
      type:'server_aesthetics_update',
      serverId: s.id,
      aesthetics: s.aesthetics,
      name: s.name,
      iconImg: s.iconImg,
      banner: s.banner,
      defChBg: s.defChBg
    }));
  }

  closeM('m-srv');
  closeM('m-srv-preview');
  renderAll();
  autoSave();
};

function updateServerPreview() {
  const s = srv();
  if(!s) return;

  const name = document.getElementById('s-name').value;
  const bg = document.getElementById('s-bg').value;
  const surf = document.getElementById('s-surf').value;
  const acc1 = document.getElementById('s-acc1').value;
  const acc2 = document.getElementById('s-acc2').value;
  const text = document.getElementById('s-text').value;
  const border = document.getElementById('s-border').value;
  const sidebarStyle = document.getElementById('s-sidebar-style').value;
  const sbGrad1 = document.getElementById('s-sb-grad1').value;
  const sbGrad2 = document.getElementById('s-sb-grad2').value;

  // Rail icon preview
  const railIcon = document.getElementById('preview-srv-rail-icon');
  const iconFile = document.getElementById('ub-srv-icon').querySelector('input').files[0];
  if(iconFile) {
    readF(iconFile).then(src => {
      railIcon.innerHTML = `<img src="${src}">`;
    });
  } else if(s.iconImg) {
    railIcon.innerHTML = `<img src="${s.iconImg}">`;
  } else {
    railIcon.innerHTML = s.icon || name[0];
  }
  railIcon.style.borderColor = acc1;

  // Banner preview
  const banner = document.getElementById('preview-srv-banner');
  const bannerFile = document.getElementById('ub-srv-ban').querySelector('input').files[0];
  if(bannerFile) {
    readF(bannerFile).then(src => {
      banner.style.backgroundImage = `url(${src})`;
      banner.style.display = 'block';
    });
  } else if(s.banner) {
    banner.style.backgroundImage = `url(${s.banner})`;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }

  // Title
  document.getElementById('preview-srv-title').textContent = name;
  document.getElementById('preview-srv-title').style.color = text;

  // Sidebar
  // Sidebar
  const sidebar = document.getElementById('preview-srv-sidebar');
  const sOpacity = document.getElementById('s-sidebar-opacity').value / 100;
  const sBlur = document.getElementById('s-sidebar-blur').value;

  if(sidebarStyle === 'gradient') {
    const grad1 = hexToRgba(sbGrad1, sOpacity);
    const grad2 = hexToRgba(sbGrad2, sOpacity);
    sidebar.style.background = `linear-gradient(180deg, ${grad1}, ${grad2})`;
  } else {
    sidebar.style.backgroundColor = hexToRgba(surf, sOpacity);
  }
  sidebar.style.backdropFilter = `blur(${sBlur}px)`;
  sidebar.style.webkitBackdropFilter = `blur(${sBlur}px)`;
  sidebar.style.color = text;

  // Main area
  const main = document.getElementById('preview-srv-main');
  main.style.background = bg;
  main.style.color = text;

  // Channel background
  const bgLayer = document.getElementById('preview-srv-bg');
  const chBgFile = document.getElementById('ub-srv-chbg').querySelector('input').files[0];
  if(chBgFile) {
    readF(chBgFile).then(src => {
      bgLayer.style.backgroundImage = `url(${src})`;
      bgLayer.style.opacity = '0.4';
    });
  } else if(s.defChBg) {
    bgLayer.style.backgroundImage = `url(${s.defChBg})`;
    bgLayer.style.opacity = '0.4';
  } else {
    bgLayer.style.backgroundImage = 'none';
  }

  // Header, content, input
  document.getElementById('preview-srv-header').style.borderBottomColor = border;
  document.getElementById('preview-srv-header').style.color = text;
  document.getElementById('preview-srv-content').style.color = text;
  document.getElementById('preview-srv-input').style.borderTopColor = border;
  document.getElementById('preview-srv-input').querySelector('div').style.background = surf;
  document.getElementById('preview-srv-input').querySelector('div').style.borderColor = border;
  document.getElementById('preview-srv-input').querySelector('div').style.color = text;

  // Avatar gradient
  document.getElementById('preview-srv-avatar').style.background = `linear-gradient(135deg, ${acc1}, ${acc2})`;
}

/* ─── CREATE SERVER ─── */
document.getElementById('btn-do-newsrv').onclick = async () => {
  const name = document.getElementById('ns-name').value.trim();
  if (!name) return;

  try {
    // Create server via API
    const newServer = await api('/servers', {
      method: 'POST',
      body: { name }
    });

    // Load the new server's channels
    const channels = await api(`/servers/${newServer.id}/channels`);

    const s = {
      id: newServer.id,
      name: newServer.name,
      icon: newServer.name[0],
      isAdmin: true,
      banner: '',
      defChBg: '',
      iconImg: '',
      aesthetics: {
        bg: '#0d1117',
        surface: '#161b22',
        acc1: document.getElementById('ns-accent').value,
        acc2: '#3fb950',
        text: '#c9d1d9',
        border: '#30363d',
        sidebarStyle: 'solid',
        sidebarGrad1: '#161b22',
        sidebarGrad2: '#1c2333',
        sidebarOpacity:1,
        sidebarBlur:10
      },
      channels: channels.map(ch => ({
        id: ch.id,
        name: ch.name,
        desc: ch.description || '',
        type: 'ch',
        bg: '',
        msgs: []
      })),
      dms: []
    };

    S.servers.push(s);
    S.srvId = s.id;
    S.chId = s.channels[0]?.id;
    S.view = 'server';

    document.getElementById('ns-name').value = '';
    closeM('m-newsrv');
    renderAll();
  } catch (err) {
    alert('Failed to create server: ' + err.message);
  }
};

/* ─── SERVER INVITES ─── */
document.getElementById('btn-invite-srv').onclick=async()=>{
  const s=srv();
  if(!s || typeof s.id !== 'number') return;
  try {
    const invite = await api(`/servers/${s.id}/invites`, { method:'POST' });
    document.getElementById('invite-code-display').value = invite.code;
    document.getElementById('invite-copied-msg').style.display = 'none';
    closeM('m-srv');
    closeM('m-srv-preview');
    openM('m-invite');
  } catch(err) {
    alert('Failed to create invite: ' + err.message);
  }
};

document.getElementById('btn-new-invite').onclick=async()=>{
  const s=srv();
  if(!s || typeof s.id !== 'number') return;
  try {
    const invite = await api(`/servers/${s.id}/invites`, { method:'POST' });
    document.getElementById('invite-code-display').value = invite.code;
    document.getElementById('invite-copied-msg').style.display = 'none';
  } catch(err) {
    alert('Failed to create invite: ' + err.message);
  }
};

document.getElementById('btn-copy-invite').onclick=()=>{
  const code = document.getElementById('invite-code-display').value;
  navigator.clipboard.writeText(code).then(()=>{
    document.getElementById('invite-copied-msg').style.display = 'block';
    setTimeout(()=>{ document.getElementById('invite-copied-msg').style.display = 'none'; }, 2000);
  });
};

// Join server - lookup invite code
let _joinInviteTimeout = null;
document.getElementById('join-invite-code').addEventListener('input', (e) => {
  clearTimeout(_joinInviteTimeout);
  const code = e.target.value.trim();
  document.getElementById('invite-preview').style.display = 'none';
  document.getElementById('invite-error').style.display = 'none';
  if(code.length < 4) return;
  _joinInviteTimeout = setTimeout(async()=>{
    try {
      const info = await api(`/invites/${code}`);
      document.getElementById('invite-srv-name').textContent = info.server_name;
      document.getElementById('invite-srv-members').textContent = `${info.member_count} members`;
      const iconEl = document.getElementById('invite-srv-icon');
      if(info.icon_img) {
        iconEl.innerHTML = `<img src="${info.icon_img}" style="width:100%;height:100%;object-fit:cover;border-radius:12px">`;
      } else {
        iconEl.textContent = info.server_name[0];
      }
      if(info.already_member) {
        document.getElementById('invite-error').textContent = 'You are already a member of this server';
        document.getElementById('invite-error').style.display = 'block';
      }
      document.getElementById('invite-preview').style.display = 'block';
    } catch(err) {
      document.getElementById('invite-error').textContent = 'Invalid invite code';
      document.getElementById('invite-error').style.display = 'block';
    }
  }, 400);
});

document.getElementById('btn-do-joinsrv').onclick=async()=>{
  const code = document.getElementById('join-invite-code').value.trim();
  if(!code) return;
  try {
    const result = await api(`/invites/${code}/join`, { method:'POST' });
    const srv = result.server;
    const channels = result.channels;

    S.servers.push({
      id: srv.id,
      name: srv.name,
      icon: srv.icon || srv.name[0],
      iconImg: srv.icon_img || '',
      banner: srv.banner || '',
      isAdmin: false,
      defChBg: srv.def_ch_bg || '',
      aesthetics: srv.aesthetics || {
        bg:'#0d1117', surface:'#161b22', acc1:'#58a6ff', acc2:'#3fb950',
        text:'#c9d1d9', border:'#30363d', sidebarStyle:'solid',
        sidebarGrad1:'#161b22', sidebarGrad2:'#1c2333'
      },
      channels: channels.map(ch => ({
        id: ch.id, name: ch.name, desc: ch.description || '',
        type:'ch', bg: ch.background || '', msgs:[]
      })),
      dms: []
    });

    S.srvId = srv.id;
    S.chId = channels[0]?.id;
    S.view = 'server';
    closeM('m-joinsrv');
    renderAll();
  } catch(err) {
    document.getElementById('invite-error').textContent = err.message || 'Failed to join server';
    document.getElementById('invite-error').style.display = 'block';
  }
};



/* ─── EDIT CHANNEL ─── */
document.getElementById('btn-do-newch').onclick = async () => {
  const name = document.getElementById('nc-name').value.trim().replace(/\s+/g, '-').toLowerCase();
  if (!name) return;

  try {
    const newChannel = await api(`/servers/${S.srvId}/channels`, {
      method: 'POST',
      body: {
        name,
        description: document.getElementById('nc-desc').value
      }
    });

    srv().channels.push({
      id: newChannel.id,
      name: newChannel.name,
      desc: newChannel.description || '',
      type: 'ch',
      bg: '',
      msgs: []
    });

    document.getElementById('nc-name').value = '';
    document.getElementById('nc-desc').value = '';
    closeM('m-newch');
    renderSidebar();
  } catch (err) {
    alert('Failed to create channel: ' + err.message);
  }
};

/* ─── CHANNEL BG ─── */
document.getElementById('btn-chbg').onclick=()=>{
  const c=ch();if(!c)return;
  document.getElementById('chbg-title').textContent=c.type==='dm'?'🖼️ DM Background':'🖼️ Channel Background';
  document.getElementById('chbg-desc').textContent=c.type==='dm'?'Set a shared background. Both users can change it.':'Set a custom background for this channel.';
  setPreview('ub-chbg',c.bg||'');S.pendingChBg=null;S.pendingChBgFile=null;
  openM('m-chbg');
};
document.getElementById('ub-chbg').querySelector('input').onchange=async function(e){
  const f=e.target.files[0];if(!f)return;
  S.pendingChBgFile=f;
  S.pendingChBg=await readF(f);setPreview('ub-chbg',S.pendingChBg);
};
document.getElementById('btn-save-chbg').onclick=async()=>{
  const c=ch();if(!c)return;
  let bgUrl = S.pendingChBg || '';

  if(S.pendingChBgFile) {
    try {
      bgUrl = await uploadFileToS3(S.pendingChBgFile);
    } catch(err) {
      console.warn('S3 upload failed, using base64:', err);
    }
  }

  if(!bgUrl) { S.pendingChBg=null;S.pendingChBgFile=null;closeM('m-chbg');return; }

  c.bg = bgUrl;

  if(c.type === 'dm' && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type:'dm_bg_change', dmChannelId:c.id, background:bgUrl }));
  } else if(c.type !== 'dm' && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type:'channel_bg_change', channelId:c.id, background:bgUrl }));
  }

  S.pendingChBg=null;S.pendingChBgFile=null;closeM('m-chbg');renderBg();autoSave();
};
document.getElementById('btn-rm-chbg').onclick=()=>{
  const c=ch();if(!c)return;
  c.bg='';

  if(c.type === 'dm' && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type:'dm_bg_change', dmChannelId:c.id, background:'' }));
  } else if(c.type !== 'dm' && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type:'channel_bg_change', channelId:c.id, background:'' }));
  }
  S.pendingChBg=null;S.pendingChBgFile=null;closeM('m-chbg');renderBg();autoSave();
};

/* ─── MEMBERS ─── */
document.getElementById('btn-members').onclick=async()=>{
  const list=document.getElementById('members-list');list.innerHTML='';

  if(S.view === 'server' && typeof S.srvId === 'number') {
    // Fetch actual server members from API
    try {
      const members = await api(`/servers/${S.srvId}/members`);
      members.forEach(m => {
        const isMe = m.user_id === S.me.id;
        upsertUser({
          id: m.user_id,
          name: m.display_name || m.username,
          color: m.color,
          accent: m.accent,
          avatar: m.avatar
        });
        list.innerHTML += memRow(isMe ? 'me' : m.user_id, isMe);
      });
    } catch(err) {
      console.error('Failed to load members:', err);
      list.innerHTML += memRow('me', true);
    }
  } else {
    list.innerHTML+=memRow('me',true);
    S.users.forEach(u=>list.innerHTML+=memRow(u.id,false));
  }

  openM('m-members');
  requestAnimationFrame(()=>{
    document.querySelectorAll('.mem-av[data-uid]').forEach(el=>el.addEventListener('click',e=>showPC(e,el.dataset.uid)));
    document.querySelectorAll('.mem-name[data-uid]').forEach(el=>el.addEventListener('click',e=>showPC(e,el.dataset.uid)));
  });
};
function memRow(uid,isMe){
  const u=U(uid);
  const avContent = u.avatar
  ? `<img src="${u.avatar}" style="width:34px;height:34px;object-fit:cover;">`
  : `<div class="default-av" style="background:${u.color};color:#fff;width:34px;height:34px">✦</div>`;
  const avW=`<div class="mem-av"${isMe?'':`data-uid="${uid}"`}>${avContent}</div>`;
  const nameW=`<span class="mem-name"${isMe?'':`data-uid="${uid}"`} style="color:${u.color}">${u.name}</span>`;
  const tag=isMe?'<span class="tag" style="margin-left:auto">You</span>':(u.friends?'<span class="tag" style="margin-left:auto;background:rgba(63,185,80,.12);color:var(--accent2)">Friend</span>':'');
  return`<div class="mem-row">${avW}${nameW}${tag}</div>`;
}

/* ─── LOGIN ─── */
/* ─── LOGIN/REGISTER SYSTEM ─── */
let isLoginMode = true;

// Tab switching
document.getElementById('tab-login').onclick = () => {
  isLoginMode = true;
  document.getElementById('tab-login').classList.add('active');
  document.getElementById('tab-register').classList.remove('active');
  document.getElementById('login-password-confirm').style.display = 'none';
  document.getElementById('login-btn').textContent = 'Login';
  hideLoginMessages();
};

document.getElementById('tab-register').onclick = () => {
  isLoginMode = false;
  document.getElementById('tab-register').classList.add('active');
  document.getElementById('tab-login').classList.remove('active');
  document.getElementById('login-password-confirm').style.display = 'block';
  document.getElementById('login-btn').textContent = 'Create Account';
  hideLoginMessages();
};

function hideLoginMessages() {
  document.getElementById('login-error').classList.remove('show');
  document.getElementById('login-success').classList.remove('show');
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.add('show');
  document.getElementById('login-success').classList.remove('show');
}

function showLoginSuccess(msg) {
  const el = document.getElementById('login-success');
  el.textContent = msg;
  el.classList.add('show');
  document.getElementById('login-error').classList.remove('show');
}

// Get stored users
function getStoredUsers() {
  try {
    return JSON.parse(localStorage.getItem('syntaxy_users') || '{}');
  } catch {
    return {};
  }
}

function saveStoredUsers(users) {
  localStorage.setItem('syntaxy_users', JSON.stringify(users));
}

// Simple hash function for password (not cryptographically secure, just for demo)
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

document.getElementById('login-btn').onclick = handleAuth;
document.getElementById('login-username').addEventListener('keydown', e => { if(e.key === 'Enter') document.getElementById('login-password').focus(); });
document.getElementById('login-password').addEventListener('keydown', e => {
  if(e.key === 'Enter') {
    if(isLoginMode) handleAuth();
    else document.getElementById('login-password-confirm').focus();
  }
});
document.getElementById('login-password-confirm').addEventListener('keydown', e => { if(e.key === 'Enter') handleAuth(); });

async function handleAuth() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const passwordConfirm = document.getElementById('login-password-confirm').value;

  hideLoginMessages();

  if (!username) {
    showLoginError('Please enter a username');
    return;
  }

  if (username.length < 3) {
    showLoginError('Username must be at least 3 characters');
    return;
  }

  if (!password) {
    showLoginError('Please enter a password');
    return;
  }

  if (password.length < 4) {
    showLoginError('Password must be at least 4 characters');
    return;
  }

  try {
    if (isLoginMode) {
      // LOGIN
      const data = await api('/auth/login', {
        method: 'POST',
        body: { username, password }
      });

      setToken(data.token);

      const defaultGallery = {
        items:[], bg:'', bgColor:'#0d1117', surface:'#161b22',
        acc1:'#58a6ff', acc2:'#3fb950', text:'#c9d1d9', border:'#30363d'
      };
      const defaultUI = {
        override:false, bg:'#0d1117', surface:'#161b22', acc1:'#58a6ff',
        acc2:'#3fb950', text:'#c9d1d9', border:'#30363d',
        sidebarStyle:'solid', sidebarGrad1:'#161b22', sidebarGrad2:'#1c2333'
      };

      // Load gallery and personalUI from server
      const serverGallery = data.user.gallery && Object.keys(data.user.gallery).length > 0
      ? { ...defaultGallery, ...data.user.gallery }
      : defaultGallery;
      const serverUI = data.user.personal_ui && Object.keys(data.user.personal_ui).length > 0
      ? { ...defaultUI, ...data.user.personal_ui }
      : defaultUI;

      S.me = {
        id: data.user.id,
        name: data.user.display_name || data.user.username,
        color: data.user.color,
        accent: data.user.accent,
        bio: data.user.bio,
        avatar: data.user.avatar,
        banner: data.user.banner,
        gallery: serverGallery
      };
      S.personalUI = serverUI;

      await loadUserData();
      await loadDMsFromDatabase();
      ensureGalleryDefaults();

      document.getElementById('login-screen').style.display = 'none';
      renderAll();
      initWebSocket();

    } else {
      // REGISTER
      if (password !== passwordConfirm) {
        showLoginError('Passwords do not match');
        return;
      }

      const data = await api('/auth/register', {
        method: 'POST',
        body: { username, password }
      });

      setToken(data.token);

      const defaultGallery = {
        items:[], bg:'', bgColor:'#0d1117', surface:'#161b22',
        acc1:'#58a6ff', acc2:'#3fb950', text:'#c9d1d9', border:'#30363d'
      };

      S.me = {
        id: data.user.id,
        name: data.user.display_name || data.user.username,
        color: data.user.color,
        accent: data.user.accent,
        bio: data.user.bio,
        avatar: data.user.avatar,
        banner: data.user.banner,
        gallery: defaultGallery
      };

      showLoginSuccess('Account created!');
      ensureGalleryDefaults();

      setTimeout(() => {
        document.getElementById('login-screen').style.display = 'none';
        renderAll();
        initWebSocket();
      }, 1000);
    }
  } catch (err) {
    showLoginError(err.message);
  }
}

function loginUser(username, userData) {
  S.me.name = username;
  if (!S.me.bio) S.me.bio = "Hey, I'm " + username;

  document.getElementById('login-screen').style.display = 'none';
  renderAll();

  const c = ch();
  if (c && c.msgs.length === 0) {
    c.msgs.unshift({
      id: Date.now() - 9999,
                   uid: '__sys__',
                   text: `Welcome ${username}! 🎉 Click + to create a server. Right-click channels to edit/delete. Right-click messages for options. Click avatars for profiles. Press Ctrl+F to search messages.`,
                   sys: true,
                   time: T()
    });
    renderMsgs();
  }

  autoSave();
}

/* ─── LOGOUT ─── */
document.getElementById('btn-logout').onclick = () => {
  if(!confirm('Log out? Your data will be saved.')) return;

  // Save current state first
  saveState();

  // Disconnect WebSocket
  if (ws) {
    ws.close();
    ws = null;
  }

  // Clear the logged-in user's name (but keep their data)
  S.me.name = '';

  // Show login screen
  document.getElementById('login-screen').style.display = 'flex';

  // Clear the input fields
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-password-confirm').value = '';
  hideLoginMessages();

  // Reset to login tab
  isLoginMode = true;
  document.getElementById('tab-login').classList.add('active');
  document.getElementById('tab-register').classList.remove('active');
  document.getElementById('login-password-confirm').style.display = 'none';
  document.getElementById('login-btn').textContent = 'Login';
};

/* ─── GALLERY ─── */
async function openGallery(uid){
  // Parse string IDs to numbers
  if (uid !== 'me' && !isNaN(uid)) uid = Number(uid);

  S.currentGalleryUserId = uid;

  let u;
  if (uid === 'me') {
    u = S.me;
  } else if (typeof uid === 'number') {
    u = await fetchFullUser(uid);
  } else {
    u = U(uid);
  }

  // Ensure gallery defaults
  const defaultGal = { items:[], bg:'', bgColor:'#0d1117', surface:'#161b22', acc1:'#58a6ff', acc2:'#3fb950', text:'#c9d1d9', border:'#30363d' };
  if (!u.gallery) u.gallery = defaultGal;
  u.gallery = { ...defaultGal, ...u.gallery };
  const gal = u.gallery;

  // Apply gallery theme
  applyGalleryTheme(gal);

  // Set page background
  const bgLayer = document.getElementById('gallery-bg');
  if(gal.bg) {
    bgLayer.style.backgroundImage = `url(${gal.bg})`;
    bgLayer.classList.add('has-img');
  } else {
    bgLayer.style.backgroundImage = 'none';
    bgLayer.style.backgroundColor = gal.bgColor;
    bgLayer.classList.remove('has-img');
  }

  // Set title
  document.getElementById('gallery-owner-name').textContent = `${u.name}'s Gallery`;

  // Hide settings button if not owner
  const settingsBtn = document.getElementById('btn-gallery-settings');
  settingsBtn.style.display = uid === 'me' ? 'block' : 'none';
  document.getElementById('gallery-controls').style.display = uid === 'me' ? 'flex' : 'none';

  renderGallery();
  document.getElementById('gallery-page').classList.add('show');
}

function applyGalleryTheme(gal){
  const page = document.getElementById('gallery-page');
  page.style.setProperty('--gal-bg', gal.bgColor);
  page.style.setProperty('--gal-surface', gal.surface);
  page.style.setProperty('--gal-acc1', gal.acc1);
  page.style.setProperty('--gal-acc2', gal.acc2);
  page.style.setProperty('--gal-text', gal.text || '#c9d1d9');
  page.style.setProperty('--gal-border', gal.border || '#30363d');

  // Apply to gallery elements
  document.getElementById('gallery-header').style.background = `rgba(${hexToRgb(gal.surface)},0.92)`;
  document.getElementById('gallery-header').style.borderColor = gal.border || '#30363d';
  document.getElementById('gallery-header').style.color = gal.text || '#c9d1d9';
  document.getElementById('gallery-controls').style.background = `rgba(${hexToRgb(gal.surface)},0.92)`;
  document.getElementById('gallery-controls').style.borderColor = gal.border || '#30363d';

  // Update button gradients
  const gradBtns = document.querySelectorAll('#gallery-page .btn.grad, #gallery-controls .btn.grad');
  gradBtns.forEach(btn => {
    btn.style.background = `linear-gradient(135deg,${gal.acc1},${gal.acc2})`;
  });
}



function hexToRgb(hex){
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `${r},${g},${b}`;
}

function renderGallery(){
  const u = U(S.currentGalleryUserId);
  const grid = document.getElementById('gallery-grid');
  const empty = document.getElementById('gallery-empty');
  const gal = u.gallery;

  // Style gallery items with theme
  const itemBorder = gal.border || '#30363d';
  const itemBg = gal.surface;

  if(!u.gallery.items || u.gallery.items.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    empty.style.color = gal.text || '#c9d1d9';
    return;
  }

  empty.style.display = 'none';
  grid.innerHTML = '';

  u.gallery.items.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = 'gallery-item';
    div.style.background = itemBg;
    div.style.borderColor = itemBorder;

    if(item.type === 'video') {
      div.innerHTML = `
      <video src="${item.src}" controls></video>
      ${S.currentGalleryUserId === 'me' ? `<button class="gallery-item-del" data-idx="${idx}">✕</button>` : ''}
      `;
    } else {
      div.innerHTML = `
      <img src="${item.src}" alt="">
      ${S.currentGalleryUserId === 'me' ? `<button class="gallery-item-del" data-idx="${idx}">✕</button>` : ''}
      `;
    }

    grid.appendChild(div);
  });

  // Wire delete buttons
  grid.querySelectorAll('.gallery-item-del').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteGalleryItem(Number(btn.dataset.idx));
    };
  });
}

function deleteGalleryItem(idx){
  if(!confirm('Delete this item?')) return;
  const u = U(S.currentGalleryUserId);
  u.gallery.items.splice(idx, 1);
  renderGallery();
  autoSave();
  syncSettingsToServer();
}

document.getElementById('btn-close-gallery').onclick = () => {
  document.getElementById('gallery-page').classList.remove('show');
  S.currentGalleryUserId = null;
  // Restore theme
  renderAll();
};

document.getElementById('btn-gallery-upload').onclick = () => {
  document.getElementById('gallery-upload').click();
};

document.getElementById('gallery-upload').onchange = async (e) => {
  const files = Array.from(e.target.files);
  if(files.length === 0) return;

  const u = U('me');

  for(const file of files) {
    const src = await readF(file);
    const type = file.type.startsWith('video/') ? 'video' : 'image';
    u.gallery.items.push({ src, type });
  }

  e.target.value = '';
  renderGallery();
  autoSave();
  syncSettingsToServer();
};

// Gallery Settings
document.getElementById('btn-gallery-settings').onclick = () => {
  const u = U('me');
  const gal = u.gallery;

  // Page background
  document.getElementById('gal-bg').value = gal.bgColor;
  document.getElementById('gal-surf').value = gal.surface;
  setPreview('ub-gallery-bg', gal.bg || '');

  // Accents
  document.getElementById('gal-acc1').value = gal.acc1;
  document.getElementById('gal-acc2').value = gal.acc2;
  document.getElementById('gal-grad-swatch').style.background = `linear-gradient(135deg,${gal.acc1},${gal.acc2})`;

  // Other colors
  document.getElementById('gal-text').value = gal.text || '#c9d1d9';
  document.getElementById('gal-border').value = gal.border || '#30363d';

  openM('m-gallery-settings');
};


// Live preview for gallery settings
['gal-bg','gal-surf','gal-acc1','gal-acc2','gal-text','gal-border'].forEach(id => {
  const el = document.getElementById(id);
  if(el) {
    el.addEventListener('input', updateGalleryPreview);
  }
});

function updateGalleryPreview(){
  const gal = U('me').gallery;

  gal.bgColor = document.getElementById('gal-bg').value;
  gal.surface = document.getElementById('gal-surf').value;
  gal.acc1 = document.getElementById('gal-acc1').value;
  gal.acc2 = document.getElementById('gal-acc2').value;
  gal.text = document.getElementById('gal-text').value;
  gal.border = document.getElementById('gal-border').value;

  // Update swatches
  document.getElementById('gal-grad-swatch').style.background = `linear-gradient(135deg,${gal.acc1},${gal.acc2})`;

  // Apply live
  applyGalleryTheme(gal);
  renderGallery();

  // Update page bg color if no image
  if(!gal.bg) {
    document.getElementById('gallery-bg').style.backgroundColor = gal.bgColor;
  }
}

document.getElementById('btn-save-gallery-settings').onclick = async () => {
  const u = U('me');
  const gal = u.gallery;

  // Save page background image
  const bgFile = document.getElementById('ub-gallery-bg').querySelector('input').files[0];
  if(bgFile) gal.bg = await readF(bgFile);

  closeM('m-gallery-settings');
  openGallery('me');
  autoSave();
  syncSettingsToServer();
};

document.getElementById('btn-reset-gallery-settings').onclick = () => {
  const u = U('me');
  u.gallery = {
    items: u.gallery.items,
    bg: '',
    bgColor: '#0d1117',
    surface: '#161b22',
    acc1: '#58a6ff',
    acc2: '#3fb950',
    text: '#c9d1d9',
    border: '#30363d'
  };
  closeM('m-gallery-settings');
  openGallery('me');
  autoSave();
  syncSettingsToServer();
};

// ============================================
// WEBSOCKET CLIENT CODE
// ============================================

// WebSocket connection
let ws = null;
let wsReconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Initialize WebSocket connection
function initWebSocket() {
  const token = getToken();
  if (!token) {
    console.log('No token found, cannot connect to WebSocket');
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  console.log('Connecting to WebSocket:', wsUrl);

  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    console.log('WebSocket connected!');
    wsReconnectAttempts = 0;

    ws.send(JSON.stringify({
      type: 'authenticate',
      token: token
    }));
  });

  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('WebSocket message received:', data.type);

      switch (data.type) {
        case 'authenticated':
          console.log('WebSocket authenticated as user:', data.username);
          break;

        case 'channel_message':
          handleNewChannelMessage(data.channelId, data.message);
          break;

        case 'dm_message':
          handleNewDMMessage(data.dmChannelId, data.message);
          break;

        case 'message_edited':
          handleMessageEdited(data.channelId, data.messageId, data.text, false);
          break;

        case 'dm_message_edited':
          handleMessageEdited(data.dmChannelId, data.messageId, data.text, true);
          break;

        case 'message_deleted':
          handleMessageDeleted(data.channelId, data.messageId, false);
          break;

        case 'dm_message_deleted':
          handleMessageDeleted(data.dmChannelId, data.messageId, true);
          break;

        case 'user_typing':
          handleTypingIndicator(data);
          break;

        case 'profile_updated':
          upsertUser({
            id: data.user.id,
            name: data.user.display_name || data.user.username,
            color: data.user.color,
            accent: data.user.accent,
            avatar: data.user.avatar,
            banner: data.user.banner,
            bio: data.user.bio
          });
          // Re-render to show updated profile everywhere
          lastRenderedChId = null;
          renderMsgs();
          renderSidebar();
          break;

        case 'error':
          console.error('WebSocket error:', data.message);
          break;

        case 'friend_request_received':
        case 'friend_request_sent':
        case 'friend_request_accepted':
        case 'friend_request_declined':
          updateFriendBadge();
          break;

        case 'dm_bg_changed': {
          const homeServer = S.servers.find(s => s.id === 'home');
          if (homeServer) {
            const dm = homeServer.dms.find(d => d.id === data.dmChannelId);
            if (dm) {
              dm.bg = data.background || '';
              const c = ch();
              if (c && c.id === data.dmChannelId) renderBg();
            }
          }
          break;
        }

        case 'channel_bg_changed': {
          for (const s of S.servers) {
            if (!s.channels) continue;
            const chan = s.channels.find(c => c.id === data.channelId);
            if (chan) {
              chan.bg = data.background || '';
              const c = ch();
              if (c && c.id === data.channelId) renderBg();
              break;
            }
          }
          break;
        }

        case 'server_aesthetics_updated': {
          const s = S.servers.find(sv => sv.id === data.serverId);
          if (s) {
            if (data.aesthetics) s.aesthetics = data.aesthetics;
            if (data.name) s.name = data.name;
            if (data.iconImg !== undefined) s.iconImg = data.iconImg;
            if (data.banner !== undefined) s.banner = data.banner;
            if (data.defChBg !== undefined) s.defChBg = data.defChBg;
            // Re-render if viewing this server (respects personal override)
            if (S.srvId === data.serverId) {
              renderAll();
            } else {
              renderRail();
            }
          }
          break;
        }
      }
    } catch (err) {
      console.error('Error parsing WebSocket message:', err);
    }
  });

  ws.addEventListener('close', () => {
    console.log('WebSocket disconnected');
    ws = null;

    if (wsReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      wsReconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
      console.log(`Reconnecting in ${delay}ms... (attempt ${wsReconnectAttempts})`);
      setTimeout(initWebSocket, delay);
    }
  });

  ws.addEventListener('error', (error) => {
    console.error('WebSocket error:', error);
  });
}

function sendMessageViaWebSocket(channelId, text, image = null, reply_to = null, isDM = false, dmChannelId = null) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('WebSocket not connected');
    return sendMessageViaHTTP(channelId, text, image, reply_to, isDM, dmChannelId);
  }

  ws.send(JSON.stringify({
    type: 'new_message',
    channelId: channelId,
    dmChannelId: dmChannelId,
    text: text,
    image: image,
    reply_to: reply_to,
    isDM: isDM
  }));
}

function editMessageViaWebSocket(messageId, text, isDM, channelId, dmChannelId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('WebSocket not connected');
    return;
  }

  ws.send(JSON.stringify({
    type: 'edit_message',
    messageId: messageId,
    text: text,
    isDM: isDM,
    channelId: channelId,
    dmChannelId: dmChannelId
  }));
}

function deleteMessageViaWebSocket(messageId, isDM, channelId, dmChannelId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('WebSocket not connected');
    return;
  }

  ws.send(JSON.stringify({
    type: 'delete_message',
    messageId: messageId,
    isDM: isDM,
    channelId: channelId,
    dmChannelId: dmChannelId
  }));
}

function sendTypingIndicator(channelId, isDM, dmChannelId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify({
    type: 'typing',
    channelId: channelId,
    isDM: isDM,
    dmChannelId: dmChannelId
  }));
}

function handleNewChannelMessage(channelId, message) {
  // Add/update sender with latest data
  upsertUser({
    id: message.user_id,
    name: message.display_name || message.username,
    color: message.color,
    accent: message.accent,
    avatar: message.avatar
  });

  const c = ch();
  if (!c || c.id !== channelId) return;
  
  // Remove optimistic temp message
  if (message.user_id === S.me.id) {
    const tempIdx = c.msgs.findIndex(m => m._temp && m.text === (message.text || ''));
    if (tempIdx > -1) {
      const tempRow = document.querySelector(`.msg-row[data-id="${c.msgs[tempIdx].id}"]`);
      if (tempRow) tempRow.remove();
      c.msgs.splice(tempIdx, 1);
    }
  }
  
  c.msgs.push({
    id: message.id,
    uid: message.user_id === S.me.id ? 'me' : message.user_id,
    text: message.text || '',
    img: message.image || null,
    reply: message.reply_to,
    time: new Date(message.created_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
              edited: message.edited,
              reactions: message.reactions || {},
              username: message.username,
              userColor: message.color || '#58a6ff',
              sys: message.is_system || false
  });

  renderMsgs();
  autoSave();
}

function handleNewDMMessage(dmChannelId, message) {
  // Add/update sender with latest data
  upsertUser({
    id: message.user_id,
    name: message.display_name || message.username,
    color: message.color,
    accent: message.accent,
    avatar: message.avatar
  });

  // Update last activity timestamp so DM sorts to top
  S.dmLastActivity[dmChannelId] = new Date().toISOString();

  // Find the DM channel in the home server
  const homeServer = S.servers.find(s => s.id === 'home');
  let dmChannel = null;
  if (homeServer) {
    dmChannel = homeServer.dms.find(d => d.id === dmChannelId);
  }

  const c = ch();
  const isViewingThisDM = c && c.id === dmChannelId;

  // If NOT viewing this DM, mark as unread and re-render sidebar
  if (!isViewingThisDM) {
    if (message.user_id !== S.me.id) {
      S.unreadDMs[dmChannelId] = (S.unreadDMs[dmChannelId] || 0) + 1;
    }
    // Still push the message to the DM's message array so it's there when they open it
    if (dmChannel && dmChannel.msgs) {
      dmChannel.msgs.push({
        id: message.id,
        uid: message.user_id === S.me.id ? 'me' : message.user_id,
        text: message.text || '',
        img: message.image || null,
        reply: message.reply_to,
        time: new Date(message.created_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
                          edited: message.edited,
                          reactions: message.reactions || {},
                          username: message.username,
                          userColor: message.color || '#58a6ff',
                          sys: message.is_system || false
      });
    }
    // Re-render sidebar to update order and show unread badge
    renderSidebar();
    autoSave();
    return;
  }

  // User IS viewing this DM — handle normally
  // Remove optimistic temp message if this is our own echo
  if (message.user_id === S.me.id) {
    const tempIdx = c.msgs.findIndex(m => m._temp && m.text === (message.text || ''));
    if (tempIdx > -1) c.msgs.splice(tempIdx, 1);
  }

  c.msgs.push({
    id: message.id,
    uid: message.user_id === S.me.id ? 'me' : message.user_id,
    text: message.text || '',
    img: message.image || null,
    reply: message.reply_to,
    time: new Date(message.created_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
              edited: message.edited,
              reactions: message.reactions || {},
              username: message.username,
              userColor: message.color || '#58a6ff',
              sys: message.is_system || false
  });

  renderMsgs();
  renderSidebar();
  autoSave();
}

function handleMessageEdited(channelOrDmId, messageId, newText, isDM) {
  const c = ch();
  if (!c) return;

  const message = c.msgs.find(m => m.id === messageId);
  if (message) {
    message.text = newText;
    message.edited = true;
    renderMsgs();
    autoSave();
  }
}

function handleMessageDeleted(channelOrDmId, messageId, isDM) {
  const c = ch();
  if (!c) return;

  const index = c.msgs.findIndex(m => m.id === messageId);
  if (index !== -1) {
    c.msgs.splice(index, 1);
    const row = document.querySelector(`.msg-row[data-id="${messageId}"]`);
    if (row) row.remove();
    autoSave();
  }
}

function handleTypingIndicator(data) {
  console.log(`${data.username} is typing...`);
}

async function sendMessageViaHTTP(channelId, text, image, reply_to, isDM, dmChannelId) {
  const token = getToken();
  const url = isDM
  ? `${API_URL}/dms/${dmChannelId}/messages`
  : `${API_URL}/channels/${channelId}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ text, image, reply_to })
    });

    if (!response.ok) {
      throw new Error('Failed to send message');
    }

    const message = await response.json();

    if (isDM) {
      handleNewDMMessage(dmChannelId, message);
    } else {
      handleNewChannelMessage(channelId, message);
    }
  } catch (error) {
    console.error('Error sending message via HTTP:', error);
    alert('Failed to send message');
  }
}

console.log('WebSocket client code loaded');

// ============================================
// USER SEARCH & FRIEND REQUESTS
// ============================================

let currentUserId = null;
const API = API_URL; // Use existing API_URL variable

// Load current user
(async function initUserSearch() {
  try {
    const res = await fetch(`${API}/me`, {
      headers: { Authorization: `Bearer ${getToken()}` }
    });
    if (res.ok) {
      const user = await res.json();
      currentUserId = user.id;
      console.log('Current user loaded:', currentUserId);
    }
  } catch (err) {
    console.error('Init user search error:', err);
  }
})();

// Close search modal
document.addEventListener('click', (e) => {
  if (e.target.id === 'user-search-close') {
    document.getElementById('user-search-overlay').classList.remove('show');
    document.getElementById('user-search-input').value = '';
    document.getElementById('user-search-results').innerHTML = '';
  }
  if (e.target.id === 'friend-requests-close') {
    document.getElementById('friend-requests-overlay').classList.remove('show');
  }
});

// Search as you type
let searchTimeout;
document.addEventListener('input', (e) => {
  if (e.target.id === 'user-search-input') {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim();

    if (query.length === 0) {
      document.getElementById('user-search-results').innerHTML = '';
      return;
    }

    searchTimeout = setTimeout(() => searchUsers(query), 300);
  }
});

async function searchUsers(query) {
  try {
    console.log('🔍 Searching for:', query);
    console.log('📡 API URL:', `${API}/users/search?q=${encodeURIComponent(query)}`);
    console.log('🔑 Token:', getToken() ? 'Present' : 'MISSING');

    const res = await fetch(`${API}/users/search?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${getToken()}` }
    });

    console.log('📨 Response status:', res.status);

    if (!res.ok) {
      const errorData = await res.json();
      console.error('❌ API Error:', errorData);
      throw new Error(errorData.error || 'Search failed');
    }

    const users = await res.json();
    console.log('✅ Found users:', users);
    await displaySearchResults(users);
  } catch (err) {
    console.error('💥 Search error:', err);
    document.getElementById('user-search-results').innerHTML =
    `<div class="search-empty">❌ Error: ${err.message}</div>`;
  }
}

// Display results
async function displaySearchResults(users) {
  const container = document.getElementById('user-search-results');

  if (users.length === 0) {
    container.innerHTML = '<div class="search-empty">No users found</div>';
    return;
  }

  container.innerHTML = '';

  for (const user of users) {
    try {
      const statusRes = await fetch(`${API}/friends/status/${user.id}`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      const statusData = await statusRes.json();

      const item = document.createElement('div');
      item.className = 'user-search-item';

      const avatar = user.avatar
      ? `<img src="${user.avatar}" alt="${user.username}">`
      : `<div style="color: ${user.color}">${user.username[0].toUpperCase()}</div>`;

      let actionButtons = '';

      if (statusData.status === 'none') {
        actionButtons = `<button class="user-search-btn primary" onclick="sendFriendRequest(${user.id}, this)">Add Friend</button>`;
      } else if (statusData.status === 'pending_sent') {
        actionButtons = `
        <button class="user-search-btn secondary" disabled>Request Sent</button>
        <button class="user-search-btn secondary" onclick="cancelFriendRequest(${statusData.requestId}, this)">Cancel</button>
        `;
      } else if (statusData.status === 'pending_received') {
        actionButtons = `
        <button class="user-search-btn primary" onclick="acceptFriendRequest(${statusData.requestId}, this)">Accept</button>
        <button class="user-search-btn secondary" onclick="declineFriendRequest(${statusData.requestId}, this)">Decline</button>
        `;
      } else if (statusData.status === 'accepted') {
        actionButtons = `<button class="user-search-btn primary" onclick="openDMWithUser(${user.id})">Message</button>`;
      }

      item.innerHTML = `
      <div class="user-search-avatar">${avatar}</div>
      <div class="user-search-info">
      <div class="user-search-name" style="color: ${user.color}">
      ${user.display_name || user.username}
      </div>
      <div class="user-search-username">@${user.username}</div>
      </div>
      <div class="user-search-actions">${actionButtons}</div>
      `;

      container.appendChild(item);
    } catch (err) {
      console.error('Error displaying user:', err);
    }
  }
}

// Send friend request
async function sendFriendRequest(friendId, button) {
  try {
    button.disabled = true;
    button.textContent = 'Sending...';

    const res = await fetch(`${API}/friends/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`
      },
      body: JSON.stringify({ friendId })
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Failed');
    }

    const request = await res.json();

    // Notify via WebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'friend_request_sent',
        targetUserId: friendId,
        requestId: request.id
      }));
    }

    // Refresh search results if search is open
    const searchInput = document.getElementById('user-search-input');
    if (searchInput && searchInput.value) {
      searchUsers(searchInput.value);
    }
    // Update badge
    updateFriendBadge();

  } catch (err) {
    console.error('Send request error:', err);
    alert(err.message);
    button.disabled = false;
    button.textContent = 'Add Friend';
  }
}

// Accept friend request
async function acceptFriendRequest(requestId, button) {
  try {
    button.disabled = true;

    const res = await fetch(`${API}/friends/request/${requestId}/accept`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`
      }
    });

    if (!res.ok) throw new Error('Failed to accept');

    // Notify sender
    const requestsRes = await fetch(`${API}/friends/requests`, {
      headers: { Authorization: `Bearer ${getToken()}` }
    });
    const requests = await requestsRes.json();
    const request = requests.find(r => r.id === requestId);

    if (request && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'friend_request_accepted',
        targetUserId: request.user_id,
        requestId: requestId
      }));
    }

    // Refresh search results if search is open
    const searchInput = document.getElementById('user-search-input');
    if (searchInput && searchInput.value) searchUsers(searchInput.value);
    updateFriendBadge();

  } catch (err) {
    console.error('Accept error:', err);
    alert('Failed to accept');
    button.disabled = false;
  }
}

// Decline/Cancel request
async function declineFriendRequest(requestId, button) {
  try {
    button.disabled = true;

    const res = await fetch(`${API}/friends/request/${requestId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${getToken()}` }
    });

    if (!res.ok) throw new Error('Failed');

    // Refresh search results if search is open
    const searchInput = document.getElementById('user-search-input');
    if (searchInput && searchInput.value) searchUsers(searchInput.value);
    updateFriendBadge();

  } catch (err) {
    console.error('Decline error:', err);
    alert('Failed to decline');
    button.disabled = false;
  }
}

/* ─── FRIENDS MODAL ─── */
document.getElementById('btn-friends').onclick = () => {
  openM('m-friends');
  switchFriendsTab('list');
  loadFriendsList();
};

document.getElementById('tab-friends-list').onclick = () => switchFriendsTab('list');
document.getElementById('tab-friends-requests').onclick = () => switchFriendsTab('requests');

function switchFriendsTab(tab) {
  const listTab = document.getElementById('tab-friends-list');
  const reqTab = document.getElementById('tab-friends-requests');
  const listPanel = document.getElementById('friends-list-panel');
  const reqPanel = document.getElementById('friends-requests-panel');

  if (tab === 'list') {
    listTab.style.color = 'var(--text)';
    listTab.style.borderBottomColor = 'var(--accent)';
    reqTab.style.color = 'var(--dim)';
    reqTab.style.borderBottomColor = 'transparent';
    listPanel.style.display = 'block';
    reqPanel.style.display = 'none';
    loadFriendsList();
  } else {
    reqTab.style.color = 'var(--text)';
    reqTab.style.borderBottomColor = 'var(--accent)';
    listTab.style.color = 'var(--dim)';
    listTab.style.borderBottomColor = 'transparent';
    listPanel.style.display = 'none';
    reqPanel.style.display = 'block';
    loadFriendRequests();
  }
}

async function loadFriendsList() {
  const panel = document.getElementById('friends-list-panel');
  panel.innerHTML = '<div style="text-align:center;padding:20px;color:var(--dim)">Loading...</div>';
  try {
    const all = await api('/friends');
    const friends = all.filter(f => f.status === 'accepted');
    if (friends.length === 0) {
      panel.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--dim);font-size:13px"><div style="font-size:36px;margin-bottom:8px;opacity:0.3">👥</div>No friends yet<br><span style="font-size:12px;opacity:0.7">Search for users to add friends</span></div>';
      return;
    }
    panel.innerHTML = '';
    friends.forEach(f => {
      const u = f.user;
      const avInner = u.avatar
      ? `<img src="${u.avatar}" style="width:38px;height:38px;border-radius:50%;object-fit:cover">`
      : `<div style="width:38px;height:38px;border-radius:50%;background:${u.color || '#58a6ff'};display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;font-weight:700">✦</div>`;

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;cursor:pointer;transition:background .15s';
      row.onmouseenter = () => row.style.background = 'var(--surface2)';
      row.onmouseleave = () => row.style.background = '';
      row.innerHTML = `
      ${avInner}
      <div style="flex:1;min-width:0">
      <div style="font-weight:600;font-size:14px;color:${u.color || '#58a6ff'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${u.display_name || u.username}</div>
      <div style="font-size:12px;color:var(--dim)">@${u.username}</div>
      </div>
      <button class="btn sec" style="font-size:12px;padding:6px 12px" data-dm-uid="${u.id}">💬 DM</button>
      `;
      row.querySelector('[data-dm-uid]').onclick = async (e) => {
        e.stopPropagation();
        try {
          const dm = await api('/dms', { method:'POST', body:{ userId: u.id } });
          await loadDMsFromDatabase();
          S.view = 'dms'; S.srvId = 'home'; S.chId = dm.id;
          closeM('m-friends');
          renderAll();
        } catch(err) { console.error('DM open failed:', err); }
      };
      row.onclick = (e) => showPC(e, u.id);
      panel.appendChild(row);
    });
  } catch(err) {
    panel.innerHTML = '<div style="text-align:center;padding:20px;color:var(--danger)">Failed to load friends</div>';
    console.error(err);
  }
}

async function loadFriendRequests() {
  const panel = document.getElementById('friends-requests-panel');
  panel.innerHTML = '<div style="text-align:center;padding:20px;color:var(--dim)">Loading...</div>';
  try {
    const all = await api('/friends/requests');
    const requests = all.filter(f => f.status === 'pending' && !f.isRequester);
    const sent = all.filter(f => f.status === 'pending' && f.isRequester);

    // Update badge
    const badge = document.getElementById('req-count-badge');
    if (requests.length > 0) {
      badge.textContent = requests.length;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }

    if (requests.length === 0 && sent.length === 0) {
      panel.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--dim);font-size:13px"><div style="font-size:36px;margin-bottom:8px;opacity:0.3">📭</div>No pending requests</div>';
      return;
    }

    panel.innerHTML = '';

    if (requests.length > 0) {
      const label = document.createElement('div');
      label.style.cssText = 'font-size:11px;font-weight:600;color:var(--dim);padding:4px 12px 8px;text-transform:uppercase;letter-spacing:0.5px';
      label.textContent = `Incoming — ${requests.length}`;
      panel.appendChild(label);

      requests.forEach(r => {
        const u = r.user;
        const avInner = u.avatar
        ? `<img src="${u.avatar}" style="width:38px;height:38px;border-radius:50%;object-fit:cover">`
        : `<div style="width:38px;height:38px;border-radius:50%;background:${u.color || '#58a6ff'};display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;font-weight:700">✦</div>`;

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px';
        row.innerHTML = `
        ${avInner}
        <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px;color:${u.color || '#58a6ff'}">${u.display_name || u.username}</div>
        <div style="font-size:12px;color:var(--dim)">@${u.username}</div>
        </div>
        <div style="display:flex;gap:6px">
        <button class="btn pri" style="font-size:12px;padding:6px 12px" data-accept="${r.id}">✓ Accept</button>
        <button class="btn dan" style="font-size:12px;padding:6px 12px" data-decline="${r.id}">✕</button>
        </div>
        `;
        row.querySelector('[data-accept]').onclick = async (e) => {
          await acceptFriendRequest(r.id, e.target);
          loadFriendRequests();
        };
        row.querySelector('[data-decline]').onclick = async (e) => {
          await declineFriendRequest(r.id, e.target);
          loadFriendRequests();
        };
        panel.appendChild(row);
      });
    }

    if (sent.length > 0) {
      const label = document.createElement('div');
      label.style.cssText = 'font-size:11px;font-weight:600;color:var(--dim);padding:12px 12px 8px;text-transform:uppercase;letter-spacing:0.5px';
      label.textContent = `Sent — ${sent.length}`;
      panel.appendChild(label);

      sent.forEach(r => {
        const u = r.user;
        const avInner = u.avatar
        ? `<img src="${u.avatar}" style="width:38px;height:38px;border-radius:50%;object-fit:cover">`
        : `<div style="width:38px;height:38px;border-radius:50%;background:${u.color || '#58a6ff'};display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;font-weight:700">✦</div>`;

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;opacity:0.7';
        row.innerHTML = `
        ${avInner}
        <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px;color:${u.color || '#58a6ff'}">${u.display_name || u.username}</div>
        <div style="font-size:12px;color:var(--dim)">@${u.username}</div>
        </div>
        <span style="font-size:12px;color:var(--dim)">⏳ Pending</span>
        `;
        panel.appendChild(row);
      });
    }
  } catch(err) {
    panel.innerHTML = '<div style="text-align:center;padding:20px;color:var(--danger)">Failed to load requests</div>';
    console.error(err);
  }
}

// Cancel (same as decline)
async function cancelFriendRequest(requestId, button) {
  await declineFriendRequest(requestId, button);
}

/* ─── FRIEND REQUEST BADGE ─── */
async function updateFriendBadge() {
  try {
    if (!getToken()) return;
    const all = await api('/friends/requests');
    const incoming = all.filter(f => f.status === 'pending' && !f.isRequester);
    const badge = document.getElementById('friends-notif-badge');
    const modalBadge = document.getElementById('req-count-badge');
    if (incoming.length > 0) {
      const label = incoming.length > 10 ? '10+' : String(incoming.length);
      badge.textContent = label;
      badge.style.display = 'flex';
      if (modalBadge) { modalBadge.textContent = label; modalBadge.style.display = 'inline'; }
    } else {
      badge.style.display = 'none';
      if (modalBadge) modalBadge.style.display = 'none';
    }
  } catch(e) { /* silent */ }
}

/* ─── SIDEBAR RESIZE ─── */
(function() {
  const handle = document.getElementById('sidebar-resize-handle');
  const layout = document.getElementById('layout');
  let dragging = false, startX, startW;
  const MIN_W = 120, MAX_W = 360;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    const computed = getComputedStyle(layout);
    const cols = computed.gridTemplateColumns.split(/\s+/);
    startW = parseFloat(cols[1]) || 240;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW = Math.min(MAX_W, Math.max(MIN_W, startW + delta));
    layout.style.setProperty('--sidebar-w', newW + 'px');
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// Open DM
async function openDMWithUser(userId) {
  try {
    const res = await fetch(`${API}/dms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`
      },
      body: JSON.stringify({ otherUserId: userId })
    });

    if (!res.ok) throw new Error('Failed to create DM');

    const dmChannel = await res.json();

    // Close search
    document.getElementById('user-search-overlay').classList.remove('show');

    // Reload DMs and navigate to the new DM
    await loadDMsFromDatabase();

    // Switch to home/DMs view
    S.srvId = 'home';
    S.view = 'dms';
    S.chId = dmChannel.id;

    renderAll();

    console.log('DM Channel opened:', dmChannel);

  } catch (err) {
    console.error('Open DM error:', err);
    alert('Failed to open DM');
  }
}

/* ═══════════════════════════════════════════════════════════
 *   EXPLORE PAGE
 *   ═══════════════════════════════════════════════════════════ */

let explorePosts = [];
let exploreLoadedCount = 0;
const explorePerLoad = 10;
let exploreCurrentCommentPostId = null;
let exploreUploadedFile = null;

function openExplorePage() {
  document.getElementById('explore-page').classList.add('show');
  explorePosts = [];
  exploreLoadedCount = 0;
  document.getElementById('explore-feed').innerHTML = '';
  // Restore saved background
  const savedBg = localStorage.getItem('syntaxy_explore_bg');
  const bgLayer = document.getElementById('explore-bg-layer');
  const page = document.getElementById('explore-page');
  if (savedBg) {
    bgLayer.style.backgroundImage = `url(${savedBg})`;
    bgLayer.classList.add('active');
    page.classList.add('glass');
  } else {
    bgLayer.style.backgroundImage = '';
    bgLayer.classList.remove('active');
    page.classList.remove('glass');
  }
  loadExplorePosts();
}

function closeExplorePage() {
  document.getElementById('explore-page').classList.remove('show');
}

// Exit button
document.getElementById('btn-exit-explore').addEventListener('click', closeExplorePage);

// Background editor
document.getElementById('btn-explore-bg').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      localStorage.setItem('syntaxy_explore_bg', dataUrl);
      document.getElementById('explore-bg-layer').style.backgroundImage = `url(${dataUrl})`;
      document.getElementById('explore-bg-layer').classList.add('active');
      document.getElementById('explore-page').classList.add('glass');
    };
    reader.readAsDataURL(file);
  };
  input.click();
});

// Upload button
document.getElementById('btn-explore-upload').addEventListener('click', () => {
  document.getElementById('explore-upload-modal').classList.add('active');
});

// Tab switching
document.getElementById('explore-tab-explore').addEventListener('click', () => {
  document.getElementById('explore-tab-explore').classList.add('active');
  document.getElementById('explore-tab-following').classList.remove('active');
  explorePosts = [];
  exploreLoadedCount = 0;
  document.getElementById('explore-feed').innerHTML = '';
  loadExplorePosts();
});

document.getElementById('explore-tab-following').addEventListener('click', () => {
  document.getElementById('explore-tab-following').classList.add('active');
  document.getElementById('explore-tab-explore').classList.remove('active');
  // Following feed - for now just loads explore
  explorePosts = [];
  exploreLoadedCount = 0;
  document.getElementById('explore-feed').innerHTML = '';
  loadExplorePosts();
});

// Search
document.getElementById('explore-search').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase().trim();
  const feed = document.getElementById('explore-feed');
  if (!query) {
    // Show all posts
    feed.querySelectorAll('.explore-post').forEach(p => p.style.display = '');
    return;
  }
  feed.querySelectorAll('.explore-post').forEach(p => {
    const title = (p.querySelector('.explore-post-title')?.textContent || '').toLowerCase();
    const body = (p.querySelector('.explore-post-body')?.textContent || '').toLowerCase();
    const user = (p.querySelector('.explore-post-user')?.textContent || '').toLowerCase();
    p.style.display = (title.includes(query) || body.includes(query) || user.includes(query)) ? '' : 'none';
  });
});

// Format numbers
function exploreFormatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

// Load posts
async function loadExplorePosts() {
  const feed = document.getElementById('explore-feed');
  const loader = document.createElement('div');
  loader.className = 'explore-loading';
  loader.innerHTML = '<div class="explore-spinner"></div>Loading posts...';
  feed.appendChild(loader);

  try {
    const posts = await api(`/posts?limit=${explorePerLoad}&offset=${exploreLoadedCount}`);
    feed.removeChild(loader);

    if (posts.length === 0 && exploreLoadedCount === 0) {
      feed.innerHTML = '<div class="explore-loading">No posts yet. Create the first one!</div>';
      return;
    }

    posts.forEach((post, i) => {
      const el = createExplorePost(post, i);
      feed.appendChild(el);
      explorePosts.push(post);
      // Increment view
      api(`/posts/${post.id}/view`, { method: 'POST' }).catch(() => {});
    });

    exploreLoadedCount += posts.length;

    if (posts.length < explorePerLoad) {
      const end = document.createElement('div');
      end.className = 'explore-loading';
      end.textContent = "You've reached the end!";
      feed.appendChild(end);
    }
  } catch (err) {
    feed.removeChild(loader);
    console.error('Error loading posts:', err);
    feed.innerHTML = '<div class="explore-loading">Failed to load posts. Please make sure you are logged in.</div>';
  }
}

// Infinite scroll
document.getElementById('explore-body').addEventListener('scroll', () => {
  const body = document.getElementById('explore-body');
  if (body.scrollTop + body.clientHeight >= body.scrollHeight - 120) {
    // Don't double-load
    if (!document.querySelector('#explore-feed .explore-loading')) {
      loadExplorePosts();
    }
  }
});

function createExplorePost(post, index) {
  const div = document.createElement('div');
  div.className = 'explore-post';
  div.style.animationDelay = `${index * 0.08}s`;
  div.dataset.postId = post.id;

  const username = post.display_name || post.username;
  const communityTag = post.community ? `<span class="explore-post-community">${post.community}</span>` : '';
  let contentHTML = '';
  if (post.content_type === 'text') {
    contentHTML = `<p>${post.content_data || ''}</p>`;
  } else if (post.content_type === 'image') {
    contentHTML = `<img src="${post.content_data}" alt="Post image">`;
  }

  div.innerHTML = `
  <div class="explore-post-header">
  <div class="explore-post-user" data-uid="${post.user_id}">
  <span class="explore-post-user-dot"></span>
  ${username}
  </div>
  ${communityTag}
  </div>
  <h2 class="explore-post-title">${post.title}</h2>
  <div class="explore-post-body">${contentHTML}</div>
  <div class="explore-post-actions">
  <button class="explore-act-btn view-act">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
  <span>${exploreFormatNum(post.views || 0)}</span>
  </button>
  <button class="explore-act-btn like-act ${post.user_liked ? 'liked' : ''}" data-post-id="${post.id}">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
  <span class="like-count">${exploreFormatNum(post.likes)}</span>
  </button>
  <button class="explore-act-btn dislike-act ${post.user_disliked ? 'disliked' : ''}" data-post-id="${post.id}">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
  <span class="dislike-count">${exploreFormatNum(post.dislikes)}</span>
  </button>
  <button class="explore-act-btn comment-act" data-post-id="${post.id}">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  <span>Comment</span>
  </button>
  <button class="explore-act-btn share-act">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
  <span>Share</span>
  </button>
  </div>
  `;

  // Username click -> profile popup
  div.querySelector('.explore-post-user').addEventListener('click', (e) => {
    const uid = parseInt(post.user_id);
    if (uid === S.me.id) {
      showPC(e, 'me');
    } else {
      // Make sure user is in the users array
      upsertUser({ id: uid, name: post.display_name || post.username, color: post.color || '#58a6ff', avatar: post.avatar || '' });
      showPC(e, uid);
    }
  });

  // Like
  const likeBtn = div.querySelector('.like-act');
  const dislikeBtn = div.querySelector('.dislike-act');
  const likeCount = div.querySelector('.like-count');
  const dislikeCount = div.querySelector('.dislike-count');

  likeBtn.addEventListener('click', async () => {
    try {
      if (post.user_liked) {
        await api(`/posts/${post.id}/interact`, { method: 'DELETE' });
        post.user_liked = false;
        likeBtn.classList.remove('liked');
        post.likes--;
      } else {
        await api(`/posts/${post.id}/interact`, { method: 'POST', body: { type: 'like' } });
        post.user_liked = true;
        likeBtn.classList.add('liked');
        post.likes++;
        if (post.user_disliked) {
          post.user_disliked = false;
          dislikeBtn.classList.remove('disliked');
          post.dislikes--;
        }
      }
      likeCount.textContent = exploreFormatNum(post.likes);
      dislikeCount.textContent = exploreFormatNum(post.dislikes);
    } catch (err) { console.error('Like error:', err); }
  });

  // Dislike
  dislikeBtn.addEventListener('click', async () => {
    try {
      if (post.user_disliked) {
        await api(`/posts/${post.id}/interact`, { method: 'DELETE' });
        post.user_disliked = false;
        dislikeBtn.classList.remove('disliked');
        post.dislikes--;
      } else {
        await api(`/posts/${post.id}/interact`, { method: 'POST', body: { type: 'dislike' } });
        post.user_disliked = true;
        dislikeBtn.classList.add('disliked');
        post.dislikes++;
        if (post.user_liked) {
          post.user_liked = false;
          likeBtn.classList.remove('liked');
          post.likes--;
        }
      }
      likeCount.textContent = exploreFormatNum(post.likes);
      dislikeCount.textContent = exploreFormatNum(post.dislikes);
    } catch (err) { console.error('Dislike error:', err); }
  });

  // Comment button
  div.querySelector('.comment-act').addEventListener('click', () => {
    openExploreComments(post.id);
  });

  // Share button
  div.querySelector('.share-act').addEventListener('click', () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(`${window.location.origin}/?post=${post.id}`);
      div.querySelector('.share-act span').textContent = 'Copied!';
      setTimeout(() => { div.querySelector('.share-act span').textContent = 'Share'; }, 1500);
    }
  });

  return div;
}

/* ─── COMMENTS ─── */

async function openExploreComments(postId) {
  exploreCurrentCommentPostId = postId;
  const modal = document.getElementById('explore-comment-modal');
  modal.classList.add('active');

  // Show post preview
  const post = explorePosts.find(p => p.id == postId);
  const preview = document.getElementById('explore-modal-post-preview');
  if (post) {
    const username = post.display_name || post.username;
    const communityTag = post.community ? `<span class="explore-post-community">${post.community}</span>` : '';
    let contentHTML = post.content_type === 'text'
    ? `<p>${post.content_data || ''}</p>`
    : `<img src="${post.content_data}" alt="Post image" style="max-height:200px">`;
    preview.innerHTML = `
    <div class="explore-post-header">
    <div class="explore-post-user"><span class="explore-post-user-dot"></span>${username}</div>
    ${communityTag}
    </div>
    <h2 class="explore-post-title">${post.title}</h2>
    <div class="explore-post-body">${contentHTML}</div>
    `;
  }

  await loadExploreComments(postId);
}

function closeExploreComments() {
  document.getElementById('explore-comment-modal').classList.remove('active');
  document.getElementById('explore-comment-input').value = '';
  exploreCurrentCommentPostId = null;
}

document.getElementById('explore-close-comments').addEventListener('click', closeExploreComments);
document.getElementById('explore-comment-modal').addEventListener('click', (e) => {
  if (e.target.id === 'explore-comment-modal') closeExploreComments();
});

document.getElementById('explore-submit-comment').addEventListener('click', async () => {
  const input = document.getElementById('explore-comment-input');
  const text = input.value.trim();
  if (text && exploreCurrentCommentPostId) {
    try {
      await api(`/posts/${exploreCurrentCommentPostId}/comments`, {
        method: 'POST', body: { text, parent_id: null }
      });
      input.value = '';
      await loadExploreComments(exploreCurrentCommentPostId);
    } catch (err) {
      console.error('Error posting comment:', err);
      alert('Failed to post comment');
    }
  }
});

async function loadExploreComments(postId) {
  try {
    const comments = await api(`/posts/${postId}/comments`);
    const list = document.getElementById('explore-comments-list');
    list.innerHTML = '';
    const topLevel = comments.filter(c => !c.parent_id);
    topLevel.forEach(comment => {
      list.appendChild(createExploreComment(comment, postId, comments));
    });
    if (comments.length === 0) {
      list.innerHTML = '<div class="explore-loading">No comments yet. Be the first!</div>';
    }
  } catch (err) {
    console.error('Error loading comments:', err);
  }
}

function createExploreComment(comment, postId, allComments) {
  const div = document.createElement('div');
  div.className = 'explore-comment-item';
  const username = comment.display_name || comment.username;

  div.innerHTML = `
  <div class="explore-comment-author" data-uid="${comment.user_id}">${username}</div>
  <div class="explore-comment-text">${comment.text}</div>
  <div class="explore-comment-actions">
  <button class="explore-comment-act c-like ${comment.user_liked ? 'liked' : ''}" data-cid="${comment.id}">
  <svg viewBox="0 0 24 24" fill="${comment.user_liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
  <span>${comment.likes}</span>
  </button>
  <button class="explore-comment-act c-dislike ${comment.user_disliked ? 'disliked' : ''}" data-cid="${comment.id}">
  <svg viewBox="0 0 24 24" fill="${comment.user_disliked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
  <span>${comment.dislikes}</span>
  </button>
  <button class="explore-comment-act c-reply-btn">Reply</button>
  </div>
  <div class="explore-comment-reply-area" id="explore-reply-${comment.id}">
  <textarea placeholder="Write a reply..."></textarea>
  <button data-parent-id="${comment.id}">Post Reply</button>
  </div>
  `;

  // Author click -> profile
  div.querySelector('.explore-comment-author').addEventListener('click', (e) => {
    const uid = parseInt(comment.user_id);
    if (uid === S.me.id) {
      showPC(e, 'me');
    } else {
      upsertUser({ id: uid, name: comment.display_name || comment.username, color: comment.color || '#58a6ff', avatar: comment.avatar || '' });
      showPC(e, uid);
    }
  });

  // Reply toggle
  const replyArea = div.querySelector('.explore-comment-reply-area');
  div.querySelector('.c-reply-btn').addEventListener('click', () => {
    replyArea.classList.toggle('active');
  });

  // Submit reply
  replyArea.querySelector('button').addEventListener('click', async () => {
    const text = replyArea.querySelector('textarea').value.trim();
    if (text) {
      try {
        await api(`/posts/${postId}/comments`, {
          method: 'POST', body: { text, parent_id: comment.id }
        });
        replyArea.querySelector('textarea').value = '';
        replyArea.classList.remove('active');
        await loadExploreComments(postId);
      } catch (err) { console.error('Reply error:', err); }
    }
  });

  // Like comment
  div.querySelector('.c-like').addEventListener('click', async () => {
    try {
      if (comment.user_liked) {
        await api(`/comments/${comment.id}/interact`, { method: 'DELETE' });
      } else {
        await api(`/comments/${comment.id}/interact`, { method: 'POST', body: { type: 'like' } });
      }
      await loadExploreComments(postId);
    } catch (err) { console.error('Comment like error:', err); }
  });

  // Dislike comment
  div.querySelector('.c-dislike').addEventListener('click', async () => {
    try {
      if (comment.user_disliked) {
        await api(`/comments/${comment.id}/interact`, { method: 'DELETE' });
      } else {
        await api(`/comments/${comment.id}/interact`, { method: 'POST', body: { type: 'dislike' } });
      }
      await loadExploreComments(postId);
    } catch (err) { console.error('Comment dislike error:', err); }
  });

  // Nested replies
  const replies = allComments.filter(c => c.parent_id === comment.id);
  replies.forEach(reply => {
    const replyEl = createExploreComment(reply, postId, allComments);
    replyEl.classList.add('reply');
    div.appendChild(replyEl);
  });

  return div;
}

/* ─── UPLOAD ─── */

document.getElementById('explore-close-upload').addEventListener('click', closeExploreUpload);
document.getElementById('explore-upload-cancel').addEventListener('click', closeExploreUpload);
document.getElementById('explore-upload-modal').addEventListener('click', (e) => {
  if (e.target.id === 'explore-upload-modal') closeExploreUpload();
});

function closeExploreUpload() {
  document.getElementById('explore-upload-modal').classList.remove('active');
  document.getElementById('explore-upload-title').value = '';
  document.getElementById('explore-upload-text').value = '';
  document.getElementById('explore-upload-community').value = '';
  document.getElementById('explore-img-preview').innerHTML = '';
  document.getElementById('explore-file-name').textContent = '';
  document.getElementById('explore-file-area').classList.remove('has-file');
  exploreUploadedFile = null;
}

// Content type toggle
document.getElementById('explore-content-type').addEventListener('change', (e) => {
  document.getElementById('explore-text-field').style.display = e.target.value === 'text' ? 'flex' : 'none';
  document.getElementById('explore-image-field').style.display = e.target.value === 'image' ? 'flex' : 'none';
});

// File area click
document.getElementById('explore-file-area').addEventListener('click', () => {
  document.getElementById('explore-file-input').click();
});

document.getElementById('explore-file-input').addEventListener('change', (e) => {
  if (e.target.files[0]) handleExploreFile(e.target.files[0]);
});

// Drag and drop
const exploreFileArea = document.getElementById('explore-file-area');
exploreFileArea.addEventListener('dragover', (e) => { e.preventDefault(); exploreFileArea.style.borderColor = 'var(--accent)'; });
exploreFileArea.addEventListener('dragleave', () => { exploreFileArea.style.borderColor = 'var(--border)'; });
exploreFileArea.addEventListener('drop', (e) => {
  e.preventDefault();
  exploreFileArea.style.borderColor = 'var(--border)';
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) handleExploreFile(file);
});

function handleExploreFile(file) {
  exploreUploadedFile = file;
  document.getElementById('explore-file-name').textContent = file.name;
  document.getElementById('explore-file-area').classList.add('has-file');
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('explore-img-preview').innerHTML = `<img src="${e.target.result}" alt="Preview">`;
  };
  reader.readAsDataURL(file);
}

// Submit post
document.getElementById('explore-upload-submit').addEventListener('click', async () => {
  const title = document.getElementById('explore-upload-title').value.trim();
  const contentType = document.getElementById('explore-content-type').value;
  const community = document.getElementById('explore-upload-community').value.trim() || null;

  if (!title) { alert('Please enter a title'); return; }

  const submitBtn = document.getElementById('explore-upload-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Posting...';

  try {
    if (contentType === 'text') {
      const text = document.getElementById('explore-upload-text').value.trim();
      if (!text) { alert('Please enter some text content'); submitBtn.disabled = false; submitBtn.textContent = 'Post'; return; }
      await api('/posts', { method: 'POST', body: { title, content_type: 'text', content_data: text, community } });
    } else {
      if (!exploreUploadedFile) { alert('Please select an image'); submitBtn.disabled = false; submitBtn.textContent = 'Post'; return; }
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(ev.target.result);
        reader.readAsDataURL(exploreUploadedFile);
      });
      await api('/posts', { method: 'POST', body: { title, content_type: 'image', content_data: base64, community } });
    }

    // Reload
    closeExploreUpload();
    explorePosts = [];
    exploreLoadedCount = 0;
    document.getElementById('explore-feed').innerHTML = '';
    await loadExplorePosts();
    document.getElementById('explore-body').scrollTop = 0;
  } catch (err) {
    console.error('Error creating post:', err);
    alert('Failed to create post');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Post';
  }
});




