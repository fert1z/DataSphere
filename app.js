/**
 * ============================================================
 * CryptoWatch — логика приложения
 * ============================================================
 * Архитектура простая и без сборки:
 *  1) Один раз при загрузке страницы запрашиваем список монет
 *     у CoinGecko (fetchData).
 *  2) Весь ответ сохраняем в памяти в переменной allCoins —
 *     это наш "источник правды".
 *  3) Поиск и сортировка НИКОГДА не обращаются к серверу заново.
 *     Они просто каждый раз пересчитывают отображаемый список
 *     на основе allCoins (applyFilters -> sortCoins -> renderCards).
 *     Поэтому интерфейс реагирует мгновенно, без сетевых задержек.
 * ============================================================
 */

// Публичный (keyless) эндпоинт CoinGecko — ключ API не требуется.
// vs_currency=usd     — цены в долларах
// order=market_cap_desc — сразу приходят отсортированными по капитализации
// per_page=50         — 50 монет достаточно, чтобы поиск/сортировка были наглядными
// sparkline=false      — не грузим лишние данные для графиков, которые не используем
const API_URL =
  'https://api.coingecko.com/api/v3/coins/markets' +
  '?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false';

// Сколько монет показываем в бегущей строке сверху
const TICKER_ITEMS_COUNT = 15;

// ---------- Состояние приложения ----------
let allCoins = [];         // полный список монет, полученный от API
let currentSort = 'rank_asc'; // текущий выбранный способ сортировки

// ---------- Ссылки на DOM-элементы (получаем один раз) ----------
const searchInput = document.getElementById('searchInput');
const sortSelect = document.getElementById('sortSelect');
const resultsCount = document.getElementById('resultsCount');
const retryBtn = document.getElementById('retryBtn');

const loadingState = document.getElementById('loadingState');
const errorState = document.getElementById('errorState');
const errorMessageText = document.getElementById('errorMessageText');
const emptyState = document.getElementById('emptyState');
const cardsGrid = document.getElementById('cardsGrid');

const tickerWrap = document.getElementById('tickerWrap');
const tickerTrack = document.getElementById('tickerTrack');

/**
 * Запрашивает данные у API.
 *
 * Помечена как async — это значит, что внутри можно использовать await
 * и "останавливать" выполнение функции до тех пор, пока промис не
 * выполнится, при этом не блокируя весь остальной JavaScript на странице
 * (пока мы ждём ответ сервера, интерфейс остаётся отзывчивым).
 */
async function fetchData() {
  showLoading();

  try {
    // await "разворачивает" промис fetch: код ниже выполнится только
    // после того, как заголовки ответа реально придут от сервера.
    const response = await fetch(API_URL);

    // fetch не бросает ошибку сам по себе на статусы 4xx/5xx —
    // он считает это "успешным" HTTP-обменом. Поэтому проверяем
    // response.ok вручную и сами решаем, что это ошибка.
    if (!response.ok) {
      if (response.status === 429) {
        // Бесплатный публичный API CoinGecko имеет невысокий лимит запросов
        throw new Error('Слишком много запросов к API. Подождите немного и нажмите «Повторить попытку».');
      }
      throw new Error(`Сервер ответил с ошибкой: ${response.status}`);
    }

    // response.json() — тоже асинхронная операция (тело ответа читается
    // потоково), поэтому её тоже нужно дожидаться через await.
    const data = await response.json();

    allCoins = data;
    renderTicker(allCoins);
    applyFilters(); // сразу отрисовываем список с учётом текущих поиска/сортировки
  } catch (error) {
    // Сюда попадём и при обрыве интернета (fetch бросит TypeError),
    // и при наших собственных throw new Error(...) выше.
    console.error('Ошибка при загрузке данных:', error);

    if (error instanceof TypeError) {
      showError('Не удалось подключиться к серверу. Проверьте интернет-соединение.');
    } else {
      showError(error.message);
    }
  }
}

/**
 * Пересобирает видимый список монет на основе:
 *  - текста в поле поиска (по названию и тикеру);
 *  - выбранного варианта сортировки.
 * Работает только с уже загруженным массивом allCoins — без единого
 * обращения к сети. Это и есть "клиентская фильтрация" из требований.
 */
function applyFilters() {
  const query = searchInput.value.trim().toLowerCase();

  const filtered = allCoins.filter((coin) =>
    coin.name.toLowerCase().includes(query) ||
    coin.symbol.toLowerCase().includes(query)
  );

  const sorted = sortCoins(filtered, currentSort);

  updateResultsCount(sorted.length, allCoins.length);
  renderCards(sorted);
}

/**
 * Возвращает НОВЫЙ отсортированный массив монет.
 * Важно: используем [...coins], чтобы скопировать массив перед сортировкой.
 * Array.prototype.sort() сортирует "на месте" (мутирует исходный массив),
 * а мы не хотим случайно испортить порядок в allCoins.
 */
function sortCoins(coins, sortType) {
  const sorted = [...coins];

  switch (sortType) {
    case 'price_desc':
      return sorted.sort((a, b) => b.current_price - a.current_price);
    case 'price_asc':
      return sorted.sort((a, b) => a.current_price - b.current_price);
    case 'name_asc':
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case 'change_desc':
      return sorted.sort(
        (a, b) => (b.price_change_percentage_24h ?? -Infinity) - (a.price_change_percentage_24h ?? -Infinity)
      );
    case 'change_asc':
      return sorted.sort(
        (a, b) => (a.price_change_percentage_24h ?? Infinity) - (b.price_change_percentage_24h ?? Infinity)
      );
    case 'rank_asc':
    default:
      return sorted.sort(
        (a, b) => (a.market_cap_rank ?? Infinity) - (b.market_cap_rank ?? Infinity)
      );
  }
}

/**
 * Отрисовывает карточки монет в сетке.
 * Если после фильтрации массив пуст — показываем состояние "ничего не найдено"
 * вместо пустой сетки.
 */
function renderCards(coins) {
  if (coins.length === 0) {
    showEmpty();
    return;
  }

  cardsGrid.innerHTML = coins.map(createCardHTML).join('');
  showCards();
}

/** Строит HTML одной карточки монеты. */
function createCardHTML(coin) {
  const change = coin.price_change_percentage_24h;
  const isPositive = (change ?? 0) >= 0;
  const changeClass = isPositive ? 'is-positive' : 'is-negative';
  const arrow = isPositive ? '▲' : '▼';
  const sign = isPositive ? '+' : '';

  return `
    <article class="coin-card" tabindex="0">
      <span class="coin-card__rank">#${coin.market_cap_rank ?? '—'}</span>
      <img class="coin-card__icon" src="${coin.image}" alt="" loading="lazy" width="40" height="40">
      <h3 class="coin-card__name">${escapeHtml(coin.name)}</h3>
      <span class="coin-card__symbol">${escapeHtml(coin.symbol)}</span>
      <p class="coin-card__price">${formatPrice(coin.current_price)}</p>
      <span class="coin-card__change ${changeClass}">
        ${arrow} ${sign}${(change ?? 0).toFixed(2)}%
      </span>
      <p class="coin-card__cap">Капитализация: ${formatMarketCap(coin.market_cap)}</p>
    </article>
  `;
}

/** Строит бегущую строку из первых N монет. Дублируем контент дважды,
 *  чтобы CSS-анимация translateX(-50%) прокручивалась бесшовно по кругу. */
function renderTicker(coins) {
  const top = coins.slice(0, TICKER_ITEMS_COUNT);

  const itemsHTML = top
    .map((coin) => {
      const change = coin.price_change_percentage_24h ?? 0;
      const isPositive = change >= 0;
      return `
        <span class="ticker-item">
          <span class="ticker-item__symbol">${escapeHtml(coin.symbol)}</span>
          <span class="ticker-item__price">${formatPrice(coin.current_price)}</span>
          <span class="ticker-item__change ${isPositive ? 'is-positive' : 'is-negative'}">
            ${isPositive ? '▲' : '▼'} ${Math.abs(change).toFixed(1)}%
          </span>
        </span>
      `;
    })
    .join('');

  tickerTrack.innerHTML = itemsHTML + itemsHTML;
  tickerWrap.hidden = false;
}

/** Форматирует цену в долларах. Для монет дешевле $1 показываем больше
 *  знаков после запятой — иначе, например, цена в 6 центов превратится в "$0.00". */
function formatPrice(price) {
  if (price === null || price === undefined || Number.isNaN(price)) return '—';

  const maximumFractionDigits = price < 0.01 ? 8 : price < 1 ? 4 : 2;

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(price);
}

/** Сокращает крупные суммы капитализации до формата "$12.34B" / "$567.89M". */
function formatMarketCap(cap) {
  if (cap === null || cap === undefined) return '—';
  if (cap >= 1e9) return `$${(cap / 1e9).toFixed(2)}B`;
  if (cap >= 1e6) return `$${(cap / 1e6).toFixed(2)}M`;
  return `$${cap.toLocaleString('en-US')}`;
}

/** Экранирует текст перед вставкой через innerHTML — простая защита
 *  на случай спецсимволов в названии монеты (хорошая практика,
 *  даже если конкретно у CoinGecko таких данных обычно не встречается). */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function updateResultsCount(shown, total) {
  resultsCount.textContent = `Показано ${shown} из ${total} монет`;
}

// ---------- Переключение состояний (загрузка / ошибка / пусто / контент) ----------

function showLoading() {
  loadingState.hidden = false;
  errorState.hidden = true;
  emptyState.hidden = true;
  cardsGrid.hidden = true;
}

function showError(message) {
  errorMessageText.textContent = message || 'Не удалось загрузить данные.';
  loadingState.hidden = true;
  errorState.hidden = false;
  emptyState.hidden = true;
  cardsGrid.hidden = true;
}

function showEmpty() {
  loadingState.hidden = true;
  errorState.hidden = true;
  emptyState.hidden = false;
  cardsGrid.hidden = true;
}

function showCards() {
  loadingState.hidden = true;
  errorState.hidden = true;
  emptyState.hidden = true;
  cardsGrid.hidden = false;
}

/**
 * Вешает все обработчики событий один раз при старте приложения.
 *  - input на поле поиска: фильтруем "на лету", при каждом нажатии клавиши.
 *  - change на select сортировки: запоминаем выбор и пересчитываем список.
 *  - click на кнопке "Повторить попытку": заново идём в сеть за данными.
 */
function setupEventListeners() {
  searchInput.addEventListener('input', applyFilters);

  sortSelect.addEventListener('change', (event) => {
    currentSort = event.target.value;
    applyFilters();
  });

  retryBtn.addEventListener('click', fetchData);
}

function init() {
  setupEventListeners();
  fetchData();
}

document.addEventListener('DOMContentLoaded', init);
