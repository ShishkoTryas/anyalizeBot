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
    ws: process.env.ETH_WS || 'wss://eth.llamarpc.com',
    factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    explorer: 'https://etherscan.io/tx/'
  },
  BSC: {
    label: 'BSC',
    ws: process.env.BSC_WS || 'wss://bsc.publicnode.com',
    factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    explorer: 'https://bscscan.com/tx/'
  },
  BASE: {
    label: 'Base',
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
  'function token1() external view returns (address)'
];
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const users = new Map();

const mainMenu = {
  reply_markup: {
    keyboard: [['ETH','BSC','BASE'], ['Завершить']],
    resize_keyboard: true,
    one_time_keyboard: true
  }
};

// Функция для очистки и валидации адреса
function cleanAndValidateAddress(input) {
  // Удаляем все не-шестнадцатеричные символы
  let cleaned = input.replace(/[^a-fA-F0-9x]/g, '');
  
  // Удаляем возможные дубликаты '0x'
  cleaned = cleaned.replace(/^0x+|0x$/g, '');
  cleaned = '0x' + cleaned;
  
  // Проверяем длину
  if (cleaned.length !== 42) {
    throw new Error(`Неверная длина адреса: ${cleaned.length} символов (должно быть 42)`);
  }
  
  return ethers.utils.getAddress(cleaned);
}

// Вспомогательная функция получения информации о токене
async function getTokenInfo(address, provider) {
  try {
    const c = new ethers.Contract(address, ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([
      c.symbol(),
      c.decimals()
    ]);
    return { symbol, decimals: decimals || 18 };
  } catch {
    return { symbol: 'TOKEN', decimals: 18 };
  }
}

// /start handler
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  // Очищаем предыдущие подписки
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
    const netKey = user.network;
    const net = NETWORKS[netKey];
    
    let tokenAddress;
    try {
      tokenAddress = cleanAndValidateAddress(text);
    } catch (e) {
      console.error('Ошибка валидации адреса:', e.message);
      return bot.sendMessage(chatId, `Ошибка адреса: ${e.message}\nПример правильного адреса: 0x742d35Cc6634C0532925a3b844Bc454e4438f44e`);
    }

    const provider = new ethers.providers.WebSocketProvider(net.ws);
    
    // Обработка ошибок подключения
    provider.on('error', (error) => {
      console.error(`${netKey} Provider Error:`, error);
      bot.sendMessage(chatId, `Ошибка подключения к сети ${netKey}. Попробуйте позже.`);
    });

    // Получаем информацию о токене
    const tokenInfo = await getTokenInfo(tokenAddress, provider);
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
    
    // Подписываемся на событие Swap конкретной пары
    const swapHandler = async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      try {
        // Пропускаем нулевые свапы
        if (amount0In.isZero() && amount1In.isZero() && 
            amount0Out.isZero() && amount1Out.isZero()) return;
        
        // Получаем детали транзакции
        const tx = await event.getTransaction();
        const txReceipt = await tx.wait();
        
        // Пропускаем неудачные транзакции
        if (!txReceipt || txReceipt.status !== 1) return;
        
        // Определяем, какой токен куда перемещается
        const tokenIn = amount0In.gt(0) ? token0 : (amount1In.gt(0) ? token1 : null);
        const tokenOut = amount0Out.gt(0) ? token0 : (amount1Out.gt(0) ? token1 : null);
        
        // Проверяем, что свап касается нашего токена
        const isOurTokenIn = tokenIn && tokenIn.toLowerCase() === tokenAddress.toLowerCase();
        const isOurTokenOut = tokenOut && tokenOut.toLowerCase() === tokenAddress.toLowerCase();
        
        // Если свап не касается нашего токена, пропускаем
        if (!isOurTokenIn && !isOurTokenOut) return;
        
        // Определяем направление сделки
        const direction = isOurTokenIn ? "🔴 ПРОДАЖА" : "🟢 ПОКУПКА";
        const baseSymbol = netKey === 'BSC' ? 'BNB' : 'ETH';
        
        // Рассчитываем суммы
        let tokenAmount, baseAmount;
        
        if (isOurTokenIn) {
          // Продажа: наш токен входит, база выходит
          tokenAmount = tokenIn === token0 ? 
            ethers.utils.formatUnits(amount0In, tokenInfo.decimals) :
            ethers.utils.formatUnits(amount1In, tokenInfo.decimals);
            
          baseAmount = tokenIn === token0 ? 
            ethers.utils.formatUnits(amount1Out, 18) :
            ethers.utils.formatUnits(amount0Out, 18);
        } else {
          // Покупка: база входит, наш токен выходит
          tokenAmount = tokenOut === token0 ? 
            ethers.utils.formatUnits(amount0Out, tokenInfo.decimals) :
            ethers.utils.formatUnits(amount1Out, tokenInfo.decimals);
            
          baseAmount = tokenOut === token0 ? 
            ethers.utils.formatUnits(amount1In, 18) :
            ethers.utils.formatUnits(amount0In, 18);
        }
        
        // Форматируем числа
        const formattedTokenAmount = parseFloat(tokenAmount).toLocaleString('en', {
          maximumFractionDigits: tokenInfo.decimals > 6 ? 4 : 2
        });
        
        const formattedBaseAmount = parseFloat(baseAmount).toLocaleString('en', {
          maximumFractionDigits: 6
        });
        
        const explorerUrl = `${net.explorer}${event.transactionHash}`;
        const time = new Date().toLocaleString();
        
        const message = `${direction} ${tokenInfo.symbol}\n` +
          `Сеть: ${net.label}\n` +
          `Трейдер: ${tx.from}\n` +
          `Сумма: ${formattedTokenAmount} ${tokenInfo.symbol}\n` +
          `За: ${formattedBaseAmount} ${baseSymbol}\n` +
          `TX: ${explorerUrl}\n` +
          `Время: ${time}`;
        
        bot.sendMessage(chatId, message);
      } catch (err) {
        console.error('Ошибка в обработчике события:', err);
      }
    };

    // Подписываемся на события
    const filter = pair.filters.Swap();
    pair.on(filter, swapHandler);
    
    // Функция для отписки
    const unsubscribe = () => {
      pair.removeAllListeners(filter);
      provider.destroy();
      console.log(`Отписались от ${tokenInfo.symbol} в ${netKey}`);
    };
    
    // Сохраняем функцию отписки
    user.subscriptions.push(unsubscribe);
    user.state = 'choose_network';
    
    bot.sendMessage(
      chatId,
      `✅ Подписка на ${tokenInfo.symbol} (${tokenAddress}) в сети ${net.label} активна!\n\nТеперь вы будете получать уведомления о сделках с этим токеном.`,
      mainMenu
    );
  }
});

// Обработка ошибок опроса
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

console.log('Бот успешно запущен! Ожидаем команд...');