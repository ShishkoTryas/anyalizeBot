require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');

// ====== Настройки ======
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Не задан BOT_TOKEN в .env');
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
    ws: process.env.BSC_WS || 'wss://go.getblock.io/c63d882b922d447f9e6c9aabfe9a573f', // ЗАМЕНИТЕ API KEY
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

// ABI Definitions
const FACTORY_ABI = ['function getPair(address,address) view returns (address)'];
const PAIR_ABI = [
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
];
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)'
];

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const users = new Map();
const activeSubscriptions = new Map();

const mainMenu = {
  reply_markup: {
    keyboard: [['ETH','BSC','BASE'], ['Завершить']],
    resize_keyboard: true,
    one_time_keyboard: true
  }
};

// Функция для очистки и валидации адреса
function cleanAndValidateAddress(input) {
  let cleaned = input.replace(/[^a-fA-F0-9x]/g, '');
  cleaned = cleaned.replace(/^0x+|0x$/g, '');
  cleaned = '0x' + cleaned;
  
  if (cleaned.length !== 42) {
    throw new Error(`Неверная длина адреса: ${cleaned.length} символов (должно быть 42)`);
  }
  
  return ethers.utils.getAddress(cleaned);
}

// Вспомогательная функция получения информации о токене
async function getTokenInfo(address, provider) {
  try {
    const c = new ethers.Contract(address, ERC20_ABI, provider);
    const [symbol, decimals, name] = await Promise.all([
      c.symbol(),
      c.decimals(),
      c.name()
    ]);
    return { 
      symbol: symbol || 'UNKNOWN', 
      decimals: decimals || 18,
      name: name || 'Unknown Token',
      address
    };
  } catch (e) {
    console.error('Ошибка получения информации о токене:', e);
    return { 
      symbol: 'TOKEN', 
      decimals: 18,
      name: 'Unknown Token',
      address
    };
  }
}

// Глобальные провайдеры для сетей
const networkProviders = {};

// Функция для получения или создания провайдера
async function getOrCreateProvider(networkKey) {
  if (networkProviders[networkKey] && networkProviders[networkKey].provider) {
    return networkProviders[networkKey].provider;
  }

  const net = NETWORKS[networkKey];
  try {
    console.log(`[${networkKey}] Создаем нового WebSocket провайдера...`);
    
    const provider = new ethers.providers.WebSocketProvider(net.ws);
    
    provider._networkKey = networkKey;
    
    // Обработчики событий
    provider.on('error', (error) => {
      console.error(`[${networkKey}] WebSocket Error:`, error);
    });
    
    provider._websocket.on('close', (code, reason) => {
      console.log(`[${networkKey}] WebSocket закрыт (${code}: ${reason})`);
      // Переподключаемся через 5 секунд
      setTimeout(() => {
        console.log(`[${networkKey}] Попытка переподключения...`);
        getOrCreateProvider(networkKey).then(newProvider => {
          // Восстанавливаем подписки
          restoreSubscriptions(networkKey, newProvider);
        }).catch(e => console.error(`[${networkKey}] Ошибка переподключения:`, e));
      }, 5000);
    });
    
    provider._websocket.on('open', () => {
      console.log(`[${networkKey}] WebSocket подключен`);
    });
    
    // Проверяем подключение
    provider.getBlockNumber()
      .then(block => console.log(`[${networkKey}] Подключено! Последний блок: ${block}`))
      .catch(e => console.error(`[${networkKey}] Ошибка проверки подключения:`, e));
    
    // Сохраняем провайдер
    networkProviders[networkKey] = {
      provider,
      subscriptions: []
    };
    
    return provider;
  } catch (e) {
    console.error(`[${networkKey}] Ошибка создания провайдера:`, e);
    // Попробуем снова через 5 секунд
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        getOrCreateProvider(networkKey)
          .then(resolve)
          .catch(reject);
      }, 5000);
    });
  }
}

// Восстановление подписок при переподключении
async function restoreSubscriptions(networkKey, newProvider) {
  const netInfo = networkProviders[networkKey];
  if (!netInfo) return;

  console.log(`[${networkKey}] Восстанавливаем ${netInfo.subscriptions.length} подписок`);
  
  // Пересоздаем подписки с новым провайдером
  for (const sub of [...netInfo.subscriptions]) {
    try {
      console.log(`[${networkKey}] Восстанавливаем подписку для ${sub.tokenSymbol}...`);
      
      // Удаляем старую подписку
      if (sub.pair && sub.pair.removeListener) {
        sub.pair.removeListener('Swap', sub.handler);
      }
      
      // Создаем новую пару с новым провайдером
      const pair = new ethers.Contract(sub.pairAddress, PAIR_ABI, newProvider);
      
      // Получаем актуальные адреса токенов
      const [token0, token1] = await Promise.all([
        pair.token0(),
        pair.token1()
      ]);
      
      // Создаем новый обработчик
      const swapHandler = createSwapHandler(
        sub.chatId,
        networkKey,
        sub.tokenAddress,
        token0,
        token1,
        sub.tokenInfo
      );
      
      // Подписываемся на события
      pair.on('Swap', swapHandler);
      
      // Обновляем подписку
      const index = netInfo.subscriptions.findIndex(s => 
        s.pairAddress === sub.pairAddress && s.chatId === sub.chatId
      );
      
      if (index !== -1) {
        netInfo.subscriptions[index] = {
          ...sub,
          pair,
          provider: newProvider,
          handler: swapHandler,
          token0,
          token1
        };
      }
      
      console.log(`[${networkKey}] Подписка восстановлена для ${sub.tokenSymbol}`);
    } catch (e) {
      console.error(`[${networkKey}] Ошибка восстановления подписки:`, e);
    }
  }
}

// Функция для создания обработчика событий Swap
function createSwapHandler(chatId, netKey, tokenAddress, token0, token1, tokenInfo) {
  const net = NETWORKS[netKey];
  
  return async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
    try {
      console.log(`[${netKey}] Swap event detected for ${tokenInfo.symbol}`);
      
      // Пропускаем нулевые свапы
      if (amount0In.isZero() && amount1In.isZero() && 
          amount0Out.isZero() && amount1Out.isZero()) return;
      
      // Определяем, какой токен куда перемещается
      const tokenIn = amount0In.gt(0) ? token0 : 
                     amount1In.gt(0) ? token1 : null;
      const tokenOut = amount0Out.gt(0) ? token0 : 
                      amount1Out.gt(0) ? token1 : null;
      
      // Проверяем, что свап касается нашего токена
      const isOurTokenIn = tokenIn && tokenIn.toLowerCase() === tokenAddress.toLowerCase();
      const isOurTokenOut = tokenOut && tokenOut.toLowerCase() === tokenAddress.toLowerCase();
      
      // Если свап не касается нашего токена, пропускаем
      if (!isOurTokenIn && !isOurTokenOut) return;
      
      // Определяем направление сделки
      const direction = isOurTokenIn ? "🔴 ПРОДАЖА" : "🟢 ПОКУПКА";
      const baseSymbol = netKey === 'BSC' ? 'BNB' : netKey === 'BASE' ? 'ETH' : 'ETH';
      
      // Рассчитываем суммы
      let tokenAmount, baseAmount;
      
      if (isOurTokenIn) {
        // Продажа: наш токен входит, база выходит
        tokenAmount = tokenIn === token0 ? amount0In : amount1In;
        baseAmount = tokenIn === token0 ? amount1Out : amount0Out;
      } else {
        // Покупка: база входит, наш токен выходит
        tokenAmount = tokenOut === token0 ? amount0Out : amount1Out;
        baseAmount = tokenOut === token0 ? amount1In : amount0In;
      }
      
      // Пропускаем слишком маленькие сделки (меньше 0.01 USD в эквиваленте)
      const minBaseAmount = ethers.utils.parseUnits('0.01', 18);
      if (baseAmount.lt(minBaseAmount)) {
        console.log(`Пропущена маленькая сделка: ${ethers.utils.formatUnits(baseAmount, 18)} ${baseSymbol}`);
        return;
      }
      
      // Получаем время блока
      const block = await event.getBlock();
      const txTime = new Date(block.timestamp * 1000).toLocaleString();
      const explorerUrl = `${net.explorer}${event.transactionHash}`;
      
      // Форматируем числа
      const formattedTokenAmount = ethers.utils.formatUnits(
        tokenAmount, 
        tokenInfo.decimals
      );
      
      const formattedBaseAmount = ethers.utils.formatUnits(baseAmount, 18);
      
      // Форматируем для вывода
      const tokenDisplay = parseFloat(formattedTokenAmount).toLocaleString('en', {
        maximumFractionDigits: tokenInfo.decimals > 6 ? 6 : 4
      });
      
      const baseDisplay = parseFloat(formattedBaseAmount).toLocaleString('en', {
        maximumFractionDigits: 6
      });
      
      const pricePerToken = (parseFloat(formattedBaseAmount) / parseFloat(formattedTokenAmount)).toFixed(8);
      
      const message = `${direction} ${tokenInfo.symbol} (${tokenInfo.name})\n` +
        `Сеть: ${net.label}\n` +
        `Сумма: ${tokenDisplay} ${tokenInfo.symbol}\n` +
        `Цена: ${pricePerToken} ${baseSymbol}\n` +
        `Общая стоимость: ${baseDisplay} ${baseSymbol}\n` +
        `TX: <a href="${explorerUrl}">${event.transactionHash.substring(0, 12)}...</a>\n` +
        `Время: ${txTime}`;
      
      bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('Ошибка в обработчике события:', err);
    }
  };
}

// /start handler
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  
  if (users.has(chatId)) {
    const user = users.get(chatId);
    user.subscriptions.forEach(unsub => unsub());
  }
  
  users.set(chatId, { 
    state: 'choose_network', 
    network: null, 
    subscriptions: [],
    tokenInfo: null
  });
  
  bot.sendMessage(chatId, 'Выберите сеть для подписки:', mainMenu);
});

// Обработчик сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!users.has(chatId)) return;
  
  const user = users.get(chatId);

  // Завершение подписок
  if (text === 'Завершить') {
    user.subscriptions.forEach(unsub => unsub());
    users.delete(chatId);
    return bot.sendMessage(chatId, 'Подписки удалены. /start для новой.');
  }

  // Выбор сети
  if (user.state === 'choose_network') {
    if (!NETWORKS[text]) {
      return bot.sendMessage(chatId, 'Пожалуйста, выберите сеть из предложенных: ETH, BSC или BASE.');
    }
    
    user.network = text;
    user.state = 'enter_contract';
    return bot.sendMessage(chatId, `Сеть ${text} выбрана. Пришлите адрес токена:`);
  }

  // Ввод контракта токена
  if (user.state === 'enter_contract') {
    user.subscriptions.forEach(unsub => unsub());
    user.subscriptions = [];
    
    const netKey = user.network;
    const net = NETWORKS[netKey];
    
    let tokenAddress;
    try {
      tokenAddress = cleanAndValidateAddress(text);
    } catch (e) {
      console.error('Ошибка валидации адреса:', e.message);
      return bot.sendMessage(chatId, `Ошибка адреса: ${e.message}\nПример правильного адреса: 0x742d35Cc6634C0532925a3b844Bc454e4438f44e`);
    }

    const provider = await getOrCreateProvider(netKey);
    
    // Получаем информацию о токене
    let tokenInfo;
    try {
      tokenInfo = await getTokenInfo(tokenAddress, provider);
    } catch (e) {
      console.error('Ошибка получения информации о токене:', e);
      return bot.sendMessage(chatId, 'Ошибка при получении информации о токене. Проверьте адрес.');
    }
    
    user.tokenInfo = tokenInfo;
    
    // Ищем пару с WETH
    const factory = new ethers.Contract(net.factory, FACTORY_ABI, provider);
    let pairAddress;
    
    try {
      pairAddress = await factory.getPair(tokenAddress, net.weth);
    } catch (e) {
      console.error('Ошибка при получении пары:', e);
      return bot.sendMessage(chatId, 'Ошибка при получении пары. Убедитесь, что адрес токена корректен и пул существует.');
    }
    
    if (pairAddress === ethers.constants.AddressZero) {
      return bot.sendMessage(chatId, 'Пул с WETH не найден.', mainMenu);
    }

    const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
    
    // Получаем адреса токенов в паре
    let token0, token1;
    try {
      [token0, token1] = await Promise.all([
        pair.token0(),
        pair.token1()
      ]);
    } catch (e) {
      console.error('Ошибка при получении информации о паре:', e);
      return bot.sendMessage(chatId, 'Ошибка при получении информации о паре.');
    }

    // Определяем порядок токенов
    const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
    const isToken1 = token1.toLowerCase() === tokenAddress.toLowerCase();
    
    if (!isToken0 && !isToken1) {
      return bot.sendMessage(chatId, 'Ошибка: указанный токен не найден в паре.', mainMenu);
    }
    
    // Создаем обработчик событий
    const swapHandler = createSwapHandler(
      chatId,
      netKey,
      tokenAddress,
      token0,
      token1,
      tokenInfo
    );

    // Подписываемся на события
    pair.on('Swap', swapHandler);
    
    // Сохраняем подписку
    const subId = `${chatId}-${netKey}-${tokenAddress}`;
    
    // Добавляем подписку в глобальный список
    if (networkProviders[netKey]) {
      networkProviders[netKey].subscriptions.push({
        chatId,
        pairAddress,
        tokenSymbol: tokenInfo.symbol,
        tokenAddress,
        tokenInfo,
        token0,
        token1,
        handler: swapHandler,
        pair,
        provider
      });
    }
    
    activeSubscriptions.set(subId, {
      network: netKey,
      pairAddress,
      pair,
      provider,
      handler: swapHandler
    });
    
    // Функция для отписки
    const unsubscribe = () => {
      try {
        pair.removeListener('Swap', swapHandler);
        activeSubscriptions.delete(subId);
        
        // Удаляем из глобального списка
        if (networkProviders[netKey]) {
          const index = networkProviders[netKey].subscriptions.findIndex(
            sub => sub.pairAddress === pairAddress && sub.chatId === chatId
          );
          if (index !== -1) {
            networkProviders[netKey].subscriptions.splice(index, 1);
          }
        }
        
        console.log(`Отписались от ${tokenInfo.symbol} в ${netKey}`);
      } catch (e) {
        console.error('Ошибка при отписке:', e);
      }
    };
    
    // Сохраняем функцию отписки
    user.subscriptions.push(unsubscribe);
    user.state = 'choose_network';
    
    // Проверяем активность пула
    try {
      const reserves = await pair.getReserves();
      const reserve0 = ethers.utils.formatUnits(reserves[0], tokenInfo.decimals);
      const reserve1 = ethers.utils.formatUnits(reserves[1], 18);
      
      bot.sendMessage(
        chatId,
        `✅ Подписка на ${tokenInfo.symbol} (${tokenInfo.name}) в сети ${net.label} активна!\n` +
        `Адрес токена: <code>${tokenAddress}</code>\n` +
        `Пул: <code>${pairAddress}</code>\n` +
        `Резервы: ${parseFloat(reserve0).toFixed(2)} ${tokenInfo.symbol} / ${parseFloat(reserve1).toFixed(4)} ${netKey === 'BSC' ? 'BNB' : 'ETH'}`,
        { parse_mode: 'HTML' }
      );
      
      console.log(`Подписка создана: ${tokenInfo.symbol} (${net.label}), резервы: ${reserve0} / ${reserve1}`);
      
      // Проверочное сообщение
      setTimeout(() => {
        bot.sendMessage(
          chatId,
          `ℹ️ Проверка работы подписки...\nЕсли в течение 5 минут вы не видите сделок, проверьте:\n1. Что пул активен\n2. Что есть торговля по токену\n3. Что бот не вывел ошибок в консоль`
        );
      }, 10000);
      
    } catch (e) {
      console.error('Ошибка при получении резервов:', e);
      bot.sendMessage(
        chatId,
        `✅ Подписка на ${tokenInfo.symbol} (${tokenInfo.name}) в сети ${net.label} активна!\n` +
        `Адрес токена: <code>${tokenAddress}</code>\n` +
        `Пул: <code>${pairAddress}</code>`,
        { parse_mode: 'HTML' }
      );
    }
  }
});

// Мониторинг состояния подписок
setInterval(() => {
  console.log("\n===== СТАТУС ПОДПИСОК =====");
  console.log(`Активных пользователей: ${users.size}`);
  
  for (const [netKey, netInfo] of Object.entries(networkProviders)) {
    if (!netInfo) continue;
    
    let statusText = 'UNKNOWN';
    if (netInfo.provider.websocket) {
      const status = netInfo.provider.websocket.readyState;
      switch(status) {
        case 0: statusText = 'CONNECTING'; break;
        case 1: statusText = 'OPEN'; break;
        case 2: statusText = 'CLOSING'; break;
        case 3: statusText = 'CLOSED'; break;
        default: statusText = 'UNKNOWN';
      }
    }
    
    console.log(`[${netKey}] Подписок: ${netInfo.subscriptions.length}`);
    console.log(`[${netKey}] WebSocket: ${netInfo.provider.connection.url}`);
    console.log(`[${netKey}] Статус: ${statusText}`);
    
    // Проверяем последний блок
    netInfo.provider.getBlockNumber()
      .then(block => console.log(`[${netKey}] Последний блок: ${block}`))
      .catch(e => console.error(`[${netKey}] Ошибка получения блока:`, e));
  }
  console.log("==========================\n");
}, 300000); // Каждые 5 минут

// Обработка ошибок опроса
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

console.log('Бот успешно запущен! Ожидаем команд...');