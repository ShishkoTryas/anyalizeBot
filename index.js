require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');

// ====== Настройки ======
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ Не задан BOT_TOKEN в .env');
  process.exit(1);
}

const NETWORKS = {
  ETH: {
    label: 'Ethereum',
    rpc: process.env.ETH_RPC || 'https://eth.llamarpc.com',
    ws: process.env.ETH_WS || 'wss://eth.llamarpc.com',
    factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    explorer: 'https://etherscan.io/tx/'
  },
  BSC: {
    label: 'BSC',
    rpc: process.env.BSC_RPC || 'https://bsc-dataseed.binance.org/',
    ws: process.env.BSC_WS || 'wss://bsc-mainnet.core.chainstack.com/44dc2637f9e528e36a7491ecb2462ebd',
    factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    explorer: 'https://bscscan.com/tx/'
  },
  BASE: {
    label: 'Base',
    rpc: process.env.BASE_RPC || 'https://mainnet.base.org',
    ws: process.env.BASE_WS || 'wss://base.llamarpc.com',
    factory: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
    weth: '0x4200000000000000000000000000000000000006',
    explorer: 'https://basescan.org/tx/'
  }
};

// ABI
const FACTORY_ABI = ['function getPair(address,address) view returns (address)'];
const PAIR_ABI = [
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)'
];
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)'
];

// init bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const users = new Map();
const networkProviders = {};

const mainMenu = {
  reply_markup: {
    keyboard: [['ETH','BSC','BASE'], ['Завершить']],
    resize_keyboard: true,
    one_time_keyboard: true
  }
};

// address cleanup
function cleanAndValidateAddress(input) {
  let addr = input.replace(/[^a-fA-F0-9x]/g, '');
  addr = addr.replace(/^0x+|0x$/g, '');
  addr = '0x' + addr;
  if (addr.length !== 42) throw new Error(`Неверная длина адреса: ${addr.length}`);
  return ethers.utils.getAddress(addr);
}

// token info
async function getTokenInfo(address, provider) {
  try {
    const c = new ethers.Contract(address, ERC20_ABI, provider);
    const [symbol, decimals, name] = await Promise.all([c.symbol(), c.decimals(), c.name()]);
    return { symbol, decimals, name, address };
  } catch {
    return { symbol: 'TOKEN', decimals: 18, name: 'Unknown', address };
  }
}

// restore subs
async function restoreSubscriptions(netKey, provider) {
  const info = networkProviders[netKey];
  if (!info) return;
  for (const sub of info.subscriptions) {
    sub.pair.removeListener('Swap', sub.handler);
    const pair = new ethers.Contract(sub.pairAddress, PAIR_ABI, provider);
    const handler = createSwapHandler(sub.chatId, netKey, sub.tokenAddress, sub.token0, sub.token1, sub.tokenInfo);
    pair.on('Swap', handler);
    Object.assign(sub, { pair, provider, handler });
  }
}

// WS heartbeat + reconnect
async function getOrCreateProvider(netKey) {
  if (networkProviders[netKey]?.provider) return networkProviders[netKey].provider;
  const net = NETWORKS[netKey];
  console.log(`[${netKey}] connecting to ${net.ws}`);
  const provider = new ethers.providers.WebSocketProvider(net.ws);
  // keepalive
  provider._websocket.on('open', () => {
    provider._websocket._socket.setKeepAlive(true, 30000);
    const ping = setInterval(() => {
      if (provider._websocket.readyState === provider._websocket.OPEN) provider._websocket.ping();
    }, 25000);
    provider._websocket.on('close', () => clearInterval(ping));
  });
  // reconnect
  provider._websocket.on('close', () => {
    console.warn(`[${netKey}] closed, reconnect in 5s`);
    setTimeout(() => {
      getOrCreateProvider(netKey).then(p => restoreSubscriptions(netKey, p));
    }, 5000);
  });
  networkProviders[netKey] = { provider, subscriptions: [] };
  return provider;
}

// swap handler
function createSwapHandler(chatId, netKey, tokenAddress, token0, token1, tokenInfo) {
  const net = NETWORKS[netKey];
  return async (s, a0i, a1i, a0o, a1o, to, event) => {
    if (a0i.isZero() && a1i.isZero() && a0o.isZero() && a1o.isZero()) return;
    let inTok = a0i.gt(0) ? token0 : token1;
    let outTok = a0o.gt(0) ? token0 : token1;
    const isIn = inTok.toLowerCase() === tokenAddress.toLowerCase();
    const direction = isIn ? '🔴 ПРОДАЖА' : '🟢 ПОКУПКА';
    const tAmt = isIn ? (inTok===token0? a0i: a1i) : (outTok===token0? a0o: a1o);
    const bAmt = isIn ? (inTok===token0? a1o: a0o) : (outTok===token0? a1i: a0i);
    if (bAmt.lt(ethers.utils.parseUnits('0.01',18))) return;
    const block = await event.getBlock();
    const time = new Date(block.timestamp*1000).toLocaleString();
    const price = (parseFloat(ethers.utils.formatUnits(bAmt,18)) / parseFloat(ethers.utils.formatUnits(tAmt,tokenInfo.decimals))).toFixed(8);
    const msg = `${direction} ${tokenInfo.symbol}\nСеть: ${net.label}\nСумма: ${parseFloat(ethers.utils.formatUnits(tAmt,tokenInfo.decimals)).toLocaleString()} ${tokenInfo.symbol}\nЦена: ${price} ETH\nTX: <a href="${net.explorer}${event.transactionHash}">${event.transactionHash.slice(0,12)}...</a>\nВремя: ${time}`;
    bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  };
}

// /start
bot.onText(/\/start/, msg => {
  const id = msg.chat.id;
  if (users.has(id)) users.get(id).subscriptions.forEach(f=>f());
  users.set(id,{state:'choose_network',subscriptions:[],tokenInfo:null});
  bot.sendMessage(id,'Выберите сеть:', mainMenu);
});

// messages
bot.on('message', async msg => {
  const id = msg.chat.id, text = msg.text;
  if (!users.has(id)) return;
  const user = users.get(id);
  if (text==='Завершить') { user.subscriptions.forEach(f=>f()); return users.delete(id)&&bot.sendMessage(id,'Все завершено'); }
  if (user.state==='choose_network') {
    if (!NETWORKS[text]) return bot.sendMessage(id,'ETH, BSC или BASE?');
    user.network = text; user.state='enter_contract'; return bot.sendMessage(id,`Сеть ${text}, адрес токена:`);
  }
  if (user.state==='enter_contract') {
    user.subscriptions.forEach(f=>f()); user.subscriptions=[];
    let token;
    try { token=cleanAndValidateAddress(text); } catch(e){return bot.sendMessage(id,e.message);}    
    const provider = await getOrCreateProvider(user.network);
    const info = await getTokenInfo(token,provider);
    user.tokenInfo = info;
    const net = NETWORKS[user.network];
    const factory = new ethers.Contract(net.factory,FACTORY_ABI,provider);
    const pairAddr = await factory.getPair(token,net.weth);
    if (pairAddr===ethers.constants.AddressZero) return bot.sendMessage(id,'Не найден пул');
    const pair = new ethers.Contract(pairAddr,PAIR_ABI,provider);
    const [t0,t1] = await Promise.all([pair.token0(),pair.token1()]);
    const handler = createSwapHandler(id,user.network,token,t0,t1,info);
    pair.on('Swap',handler);
    networkProviders[user.network].subscriptions.push({chatId:id,pairAddress:pairAddr,tokenAddress:token,tokenInfo:info,token0:t0,token1:t1,handler,pair});
    user.subscriptions.push(()=>pair.removeListener('Swap',handler));
    user.state='choose_network';
    bot.sendMessage(id,`✅ Подписка на ${info.symbol} активна`);
  }
});

console.log('Бот запущен');
