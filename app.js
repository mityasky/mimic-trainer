// ===== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ =====
let currentCameraStream = null;
let bodyPixModel = null;
let emotionModelLoaded = false;
let emotionDetectionInterval = null;
let score = 0;
let highScore = parseInt(localStorage.getItem('mimicHighScore')) || 0;
let lastRecordNotificationTime = 0; // Время последнего показа уведомления
const RECORD_COOLDOWN = 5000;       // Задержка 5 секунд между показами
let currentEmotionIndex = 0;
// ===== НАСТРОЙКИ ЗВУКА =====
let soundEnabled = true; // По умолчанию звук включён
// ===== ПЕРЕМЕННЫЕ ДЛЯ ИНДИКАТОРОВ =====
let lowLightWarningDismissed = false;
let lightCheckInterval = null;
const LIGHT_THRESHOLD = 60; // Порог освещённости (0-255)
// Канвас для проверки освещения (переиспользуемый)
let lightCheckCanvas = null;
let lightCheckCtx = null;
let detectionThreshold = 0.5; // Текущий порог (по умолчанию Medium)
const DIFFICULTY_THRESHOLDS = [0.20, 0.5, 0.92];
const DIFFICULTY_LABELS = ['Easy', 'Medium', 'Hard'];
// ===== ДЛЯ КОМБИНИРОВАННОЙ СЛОЖНОСТИ =====
let hardStreakCount = 0;           // Счётчик кадров с правильной эмоцией
const HARD_STREAK_REQUIRED = 4;     // Сколько кадров подряд нужно (4 × 500мс = 2 сек)
const HARD_CLARITY_GAP = 0.35;      // Мин. разрыв между 1-й и 2-й эмоцией для Hard
let frameSkip = 0;
const detectorOptions = new faceapi.TinyFaceDetectorOptions({
  inputSize: 512,
  scoreThreshold: 0.6
});

// Список эмоций для тренировки
const EMOTIONS = [
  { name: 'Радость', key: 'happy', emoji: '😊', imgs: ['emotions/happy.jpg', 'emotions/happy2.jpg', 'emotions/happy3.jpg', 'emotions/happy4.jpg'] },
  { name: 'Грусть', key: 'sad', emoji: '😢', imgs: ['emotions/sad.jpg', 'emotions/sad2.jpg', 'emotions/sad3.jpg', 'emotions/sad4.jpg'] },
  { name: 'Злость', key: 'angry', emoji: '😠', imgs: ['emotions/angry.jpg', 'emotions/angry2.jpg', 'emotions/angry3.jpg', 'emotions/angry4.jpg'] },
  { name: 'Удивление', key: 'surprised', emoji: '😮', imgs: ['emotions/surprised.jpg', 'emotions/surprised2.jpg', 'emotions/surprised3.jpg', 'emotions/surprised4.jpg'] },
  { name: 'Страх', key: 'fearful', emoji: '😨', imgs: ['emotions/fearful.jpg', 'emotions/fearful2.jpg', 'emotions/fearful3.jpg', 'emotions/fearful4.jpg'] },
  { name: 'Отвращение', key: 'disgusted', emoji: '🤢', imgs: ['emotions/disgusted.jpg', 'emotions/disgusted2.jpg', 'emotions/disgusted3.jpg', 'emotions/disgusted4.jpg'] }
];

const EMOTION_MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';
const EAR_THRESHOLD = 0.25;
const MAR_THRESHOLD = 0.65;

// ===== ИНИЦИАЛИЗАЦИЯ =====
document.addEventListener('DOMContentLoaded', () => {
  initTensorFlow();
  initLanguage();
  initSound();
  loadEmotionImage();
  updateScoreDisplay();
  initThemeToggle();
  initDifficultySlider();
});

// ===== УПРАВЛЕНИЕ КАМЕРОЙ =====
window.startCamera = async function () {
  const video = document.getElementById('camera-feed');
  const startBtn = document.getElementById('btn-start-cam');
  const stopBtn = document.getElementById('btn-stop-cam');
  const camBadge = document.getElementById('camera-status-badge');

  // ПОКАЗЫВАЕМ ИНДИКАТОР ЗАГРУЗКИ
  showLoadingIndicator(true);

  try {
    currentCameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: 640,
        height: 480,
        facingMode: 'user'
      }
    });

    video.srcObject = currentCameraStream;
    video.style.display = 'block';

    startBtn.style.display = 'none';
    stopBtn.style.display = 'inline-block';
    stopBtn.disabled = false;
    camBadge.style.display = 'block';

    // Запускаем модели и детекцию
    await loadBodyPixModel();
    startPersonDetection();
    await loadEmotionModels();
    startEmotionDetection();

    // ЗАПУСКАЕМ ПРОВЕРКУ ОСВЕЩЕНИЯ
    startLightCheck(video);

    console.log('✅ Camera started');
  } catch (err) {
    console.error('❌ Camera error:', err);
    alert(translations[currentLang].notifyCameraError);
  } finally {
    // СКРЫВАЕМ ИНДИКАТОР ЗАГРУЗКИ
    showLoadingIndicator(false);
  }
};

window.stopCamera = function () {
  const video = document.getElementById('camera-feed');
  const startBtn = document.getElementById('btn-start-cam');
  const stopBtn = document.getElementById('btn-stop-cam');
  const camBadge = document.getElementById('camera-status-badge');

  if (currentCameraStream) {
    currentCameraStream.getTracks().forEach(track => track.stop());
    currentCameraStream = null;
  }

  stopEmotionDetection();
  stopPersonDetection();
  stopLightCheck(); // ОСТАНАВЛИВАЕМ ПРОВЕРКУ ОСВЕЩЕНИЯ
  video.srcObject = null;
  video.style.display = 'none';

  startBtn.style.display = 'inline-block';
  stopBtn.style.display = 'none';
  stopBtn.disabled = true;
  camBadge.style.display = 'none';

  // СКРЫВАЕМ ВСЕ ПРЕДУПРЕЖДЕНИЯ
  const warning = document.getElementById('lowlight-warning');
  if (warning) {
    warning.classList.remove('active');
  }

  resetLowLightWarning(); // СБРАСЫВАЕМ СОСТОЯНИЕ

  console.log('🛑 Camera stopped');
};

async function initTensorFlow() {
  try {
    await tf.setBackend('webgl');
    await tf.ready();
    console.log('🚀 TF backend: WebGL');
  } catch (e) {
    await tf.setBackend('cpu');
    await tf.ready();
    console.log('🐢 TF backend: CPU');
  }
}

// ===== ЗАГРУЗКА МОДЕЛЕЙ =====
async function loadBodyPixModel() {
  if (bodyPixModel) return;
  console.log('🔄 Loading BodyPix...');
  try {
    bodyPixModel = await bodyPix.load({
      architecture: 'MobileNetV1',
      outputStride: 16,
      multiplier: 0.75,
      quantBytes: 2
    });
    console.log('✅ BodyPix loaded');
  } catch (e) {
    console.error('❌ BodyPix error:', e);
  }
}

async function loadEmotionModels() {
  if (emotionModelLoaded) return;
  console.log('🔄 Loading face-api models...');
  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri(EMOTION_MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(EMOTION_MODEL_URL);
    await faceapi.nets.faceExpressionNet.loadFromUri(EMOTION_MODEL_URL);
    emotionModelLoaded = true;
    console.log('✅ Emotion models loaded');
  } catch (e) {
    console.error('❌ Emotion models error:', e);
  }
}

// ===== РАСПОЗНАВАНИЕ ЭМОЦИЙ =====
async function detectEmotion() {
  frameSkip++;
  if (frameSkip % 1 !== 0) return; // множитель 2 равен пропуску одно кадра для снижения нагрузки
  console.log('detect run');
  const video = document.getElementById('camera-feed');
  if (!emotionModelLoaded || !video || video.readyState < 2) return;

  try {
    const detections = await faceapi.detectAllFaces(
      video,
      detectorOptions
    ).withFaceLandmarks().withFaceExpressions();

    if (detections?.[0]?.expressions) {
      const expressions = detections[0].expressions;
      let dominant = 'neutral', maxScore = 0;

      for (const [emotion, score] of Object.entries(expressions)) {
        if (score > maxScore) { maxScore = score; dominant = emotion; }
      }

      // Проверка: совпадает ли с целевой эмоцией?
      const targetKey = EMOTIONS[currentEmotionIndex].key;
      const currentLevel = parseInt(document.getElementById('difficulty-slider')?.value || 1);

      // Базовая проверка для всех уровней
      let isCorrect = (dominant === targetKey && maxScore > detectionThreshold);

      // КОМБИНИРОВАННАЯ ПРОВЕРКА ДЛЯ HARD (уровень 2)
      if (currentLevel === 2) {
        // 1. Сортируем все оценки эмоций для поиска второй по величине
        const scores = Object.values(expressions).sort((a, b) => b - a);
        const secondBest = scores[1] || 0;

        // Четыре условия для Hard (все должны быть true):
        const meetsTarget = (dominant === targetKey);                    // Эмоция совпадает с целевой
        const meetsThreshold = maxScore >= 0.92;                         // Уверенность ≥92%
        const meetsGap = (maxScore - secondBest) >= HARD_CLARITY_GAP;   // Разрыв ≥35 п.п.

        // Инкремент счётчика ТОЛЬКО если первые три условия выполнены
        if (meetsTarget && meetsThreshold && meetsGap) {
          hardStreakCount++;
        } else {
          hardStreakCount = 0; // Сброс при любом провале
        }

        // Удержание: проверяем, набрали ли нужное количество кадров подряд
        const meetsStability = (hardStreakCount >= HARD_STREAK_REQUIRED);

        // Баллы только если ВСЕ четыре условия выполнены
        isCorrect = meetsTarget && meetsThreshold && meetsGap && meetsStability;

        // 🔍 Отладка в консоль
        console.log(`🔍 Hard: ${dominant}=${maxScore.toFixed(2)}, 2nd=${secondBest.toFixed(2)}, gap=${(maxScore - secondBest).toFixed(2)}, streak=${hardStreakCount}/${HARD_STREAK_REQUIRED} → ${isCorrect ? '✅' : '❌'}`);
      } else {
        // Для Easy/Medium сбрасываем счётчик
        hardStreakCount = 0;
      }

      updateDetectedEmotion(dominant, maxScore);
      giveFeedback(isCorrect, dominant);

      if (isCorrect) {
        addScore(10);
        playSuccessSound(); // опционально
      }
    }
  } catch (e) {
    if (!e.message?.includes('backend')) {
      console.error('❌ Detection error:', e);
    }
  }
}

let animationRunning = false;
let lastDetectionTime = 0;
const DETECTION_INTERVAL = 500;

function startEmotionDetection() {
  if (animationRunning) return;
  animationRunning = true;
  emotionLoop();
}

function emotionLoop() {
  if (!animationRunning) return;

  const now = Date.now();

  if (now - lastDetectionTime > DETECTION_INTERVAL) {
    detectEmotion();
    lastDetectionTime = now;
  }

  requestAnimationFrame(emotionLoop);
}

window.addEventListener('beforeunload', () => {
  stopEmotionDetection();
  stopPersonDetection();
  stopLightCheck();
  if (currentCameraStream) {
    currentCameraStream.getTracks().forEach(t => t.stop());
  }
});

function stopEmotionDetection() {
  animationRunning = false;
}

// ===== ЛОГИКА ТРЕНАЖЁРА =====
function loadEmotionImage() {
  const emotion = EMOTIONS[currentEmotionIndex];

  // Случайный выбор изображения из массива imgs
  const randomImage = emotion.imgs[Math.floor(Math.random() * emotion.imgs.length)];
  document.getElementById('emotion-image').src = randomImage;

  // Обновляем название эмоции из словаря переводов
  const emotionKey = emotion.key.charAt(0).toUpperCase() + emotion.key.slice(1);
  const emotionName = translations[currentLang]?.[`emotion${emotionKey}`] || emotion.name;
  document.getElementById('emotion-name').textContent = `${emotionName} ${emotion.emoji}`;

  // Сбрасываем отображение распознанной эмоции и обратную связь
  document.getElementById('detected-emotion').textContent = '--';
  document.getElementById('feedback').textContent = '';
  document.getElementById('feedback').className = 'feedback';
}

function updateDetectedEmotion(emotion, confidence) {
  const emojiMap = { happy: '😊', sad: '😢', angry: '😠', surprised: '😮', fearful: '😨', disgusted: '🤢', neutral: '😐' };
  document.getElementById('detected-emotion').innerHTML =
    `${emojiMap[emotion] || '😐'} ${emotion} <small style="opacity:0.7">(${Math.round(confidence * 100)}%)</small>`;
  const slider = document.getElementById('difficulty-slider');
  if (slider && parseInt(slider.value) === 2 && currentEmotionIndex !== undefined) {
    const progress = Math.min(100, Math.round((hardStreakCount / HARD_STREAK_REQUIRED) * 100));
    const progressEl = document.getElementById('hard-progress');
    if (progressEl) {
      const fillBar = progressEl.firstElementChild; // ← Получаем ВНУТРЕННИЙ блок
      if (fillBar) {
        fillBar.style.width = `${progress}%`; // ← Меняем ширину заполнения
      }
    }
  }
}

function giveFeedback(isCorrect, detected) {
  const feedback = document.getElementById('feedback');
  if (isCorrect) {
    feedback.textContent = translations[currentLang].feedbackCorrect;
    feedback.className = 'feedback correct';
  } else if (detected !== 'neutral' && detected !== 'undefined') {
    // Переводим эмоцию для показа в подсказке
    const emotionKey = EMOTIONS[currentEmotionIndex].key;
    const emotionName = translations[currentLang][`emotion${emotionKey.charAt(0).toUpperCase() + emotionKey.slice(1)}`] || emotionKey;
    feedback.textContent = `${translations[currentLang].feedbackIncorrect} ${emotionName} ${EMOTIONS[currentEmotionIndex].emoji}`;
    feedback.className = 'feedback incorrect';
  }
}

function addScore(points) {
  score += points;

  if (score > highScore) {
    highScore = score;
    localStorage.setItem('mimicHighScore', highScore);
    showRecordNotification();
  }

  updateScoreDisplay();
}

function updateScoreDisplay() {
  const scoreEl = document.getElementById('score');
  const highScoreEl = document.getElementById('high-score');

  if (scoreEl) scoreEl.textContent = score;
  if (highScoreEl) highScoreEl.textContent = `🏆 ${highScore}`;
}

function nextEmotion() {
  currentEmotionIndex = (currentEmotionIndex + 1) % EMOTIONS.length;
  loadEmotionImage();
}

function prevEmotion() {
  currentEmotionIndex = (currentEmotionIndex - 1 + EMOTIONS.length) % EMOTIONS.length;
  loadEmotionImage();
}

function resetScore() {
  if (confirm('Сбросить баллы?')) {
    score = 0;
    updateScoreDisplay();
  }
}

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
function playSuccessSound() {
  // Если звук выключен — не воспроизводим
  if (!soundEnabled) return;
  // Опционально: короткий позитивный звук
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch (e) { }
}

// ===== BODY SEGMENTATION (упрощённо) =====
let bodySegmentationInterval = null;
let bodySegmentationCanvas = null;
let bodySegmentationCtx = null;

// ===== ВСТАВИТЬ ЭТУ ФУНКЦИЮ ПЕРЕД startPersonDetection =====
function drawPersonContour(canvas, segmentation) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!segmentation?.data) return;

  const { width, height, data } = segmentation;
  // Быстрая проверка: есть ли вообще пиксели человека в кадре
  const hasPerson = data.some(v => v === 1);
  if (!hasPerson) return;

  // Масштабируем координаты маски под реальный размер canvas (видео)
  const scaleX = canvas.width / width;
  const scaleY = canvas.height / height;

  ctx.fillStyle = 'rgba(67, 97, 238, 0.9)'; // Цвет контура (совпадает с --primary)
  const step = 2; // Пропускаем каждый 2-й пиксель для оптимизации (визуально контур остаётся плавным)

  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const idx = y * width + x;
      if (data[idx] === 1) {
        // Проверяем 8 соседей. Если хотя бы один фон (0) -> это край фигуры
        const isEdge =
          data[idx - 1] === 0 || data[idx + 1] === 0 ||
          data[idx - width] === 0 || data[idx + width] === 0 ||
          data[idx - width - 1] === 0 || data[idx - width + 1] === 0 ||
          data[idx + width - 1] === 0 || data[idx + width + 1] === 0;

        if (isEdge) {
          ctx.fillRect(x * scaleX, y * scaleY, step * scaleX, step * scaleY);
        }
      }
    }
  }
}

// ===== ЗАМЕНИТЕ ЭТУ ФУНКЦИЮ В ФАЙЛЕ =====
function startPersonDetection() {
  if (bodySegmentationInterval) return;
  const canvas = document.getElementById('body-segmentation-canvas');
  const video = document.getElementById('camera-feed');
  if (canvas && !bodySegmentationCanvas) {
    bodySegmentationCanvas = canvas;
    bodySegmentationCtx = canvas.getContext('2d');
  }
  bodySegmentationInterval = setInterval(async () => {
    // ДОБАВЛЕНО: проверяем готовность видео перед работой с videoWidth
    if (!bodyPixModel || !video || video.readyState < 2 || video.videoWidth === 0) return;

    try {
      const segmentation = await bodyPixModel.segmentPerson(video, {
        internalResolution: 'medium',
        segmentationThreshold: 0.7
      });

      // БЕЗОПАСНАЯ синхронизация размера canvas с видео
      if (bodySegmentationCanvas &&
        (bodySegmentationCanvas.width !== video.videoWidth ||
          bodySegmentationCanvas.height !== video.videoHeight)) {
        bodySegmentationCanvas.width = video.videoWidth;
        bodySegmentationCanvas.height = video.videoHeight;
      }

      // ОТРИСОВКА ТОЛЬКО КОНТУРА (середина остаётся прозрачной)
      if (bodySegmentationCanvas) {
        drawPersonContour(bodySegmentationCanvas, segmentation);
      }

    } catch (e) {
      console.error('Segmentation error:', e);
    }
  }, 100); // ~3 FPS
}

function stopPersonDetection() {
  if (bodySegmentationInterval) {
    clearInterval(bodySegmentationInterval);
    bodySegmentationInterval = null;
  }
  if (bodySegmentationCtx && bodySegmentationCanvas) {
    bodySegmentationCtx.clearRect(0, 0, bodySegmentationCanvas.width, bodySegmentationCanvas.height);
  }
}

// ===== УПРАВЛЕНИЕ ТЕМОЙ =====
function initThemeToggle() {
  const themeBtn = document.getElementById('theme-toggle');
  const html = document.documentElement;

  // Защита: если кнопка не найдена — выходим
  if (!themeBtn) {
    console.warn('⚠️ Theme toggle button not found');
    return;
  }

  // Вспомогательная функция: обновляет иконку кнопки
  function updateThemeButton(isDark) {
    themeBtn.textContent = isDark ? '☀️' : '🌙';
    themeBtn.title = isDark ? 'Переключить на светлую тему' : 'Переключить на тёмную тему';
  }

  // Определяем желаемую тему
  const savedTheme = localStorage.getItem('theme');
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  let isDark = false;
  if (savedTheme === 'dark') {
    isDark = true;
  } else if (savedTheme === 'light') {
    isDark = false;
  } else {
    // Нет сохранённой настройки — используем системную
    isDark = systemPrefersDark;
  }

  // Применяем тему при загрузке
  if (isDark) {
    html.setAttribute('data-theme', 'dark');
  } else {
    html.removeAttribute('data-theme');
  }
  updateThemeButton(isDark);

  // Обработчик клика по кнопке
  themeBtn.addEventListener('click', () => {
    isDark = !isDark; // Переключаем состояние

    if (isDark) {
      html.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    } else {
      html.removeAttribute('data-theme');
      localStorage.setItem('theme', 'light');
    }

    updateThemeButton(isDark);
    setTimeout(syncCusdisTheme, 100);
    console.log(`🎨 Theme: ${isDark ? 'dark' : 'light'}`);
  });
}

// ===== УПРАВЛЕНИЕ РАЗМЕРОМ КАМЕРЫ =====
let isCompactCamera = false;

function toggleCameraSize() {
  // Меняем ссылку на обёртку вместо видео
  const overlay = document.querySelector('.video-overlay');
  const wrapper = document.querySelector('.camera-wrapper');
  if (!overlay || !wrapper) return;

  isCompactCamera = !isCompactCamera;

  if (isCompactCamera) {
    overlay.style.maxWidth = '320px';
    wrapper.style.padding = '8px';
    //  используем перевод
    showStatus(translations[currentLang].notifyCompactMode, 'info');
  } else {
    overlay.style.maxWidth = '420px';
    wrapper.style.padding = '';
    //  используем перевод
    showStatus(translations[currentLang].notifyNormalMode, 'info');
  }
}

// ===== ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ПОКАЗА СТАТУСА =====
function showStatus(message, type = 'info') {
  // Создаём временное уведомление если нет элемента
  let statusEl = document.getElementById('temp-status');

  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.id = 'temp-status';
    statusEl.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      padding: 10px 20px;
      border-radius: 8px;
      background: var(--bg-card);
      color: var(--text);
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
      font-size: 13px;
      z-index: 1000;
      animation: statusFade 2s ease forwards;
    `;
    document.body.appendChild(statusEl);

    // Добавляем анимацию
    if (!document.getElementById('status-anim-style')) {
      const style = document.createElement('style');
      style.id = 'status-anim-style';
      style.textContent = `
        @keyframes statusFade {
          0%, 100% { opacity: 0; transform: translateX(-50%) translateY(10px); }
          10%, 90% { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `;
      document.head.appendChild(style);
    }
  }

  // Обновляем текст и цвет
  const colors = {
    success: 'var(--success)',
    error: 'var(--danger)',
    info: 'var(--primary)',
    warning: 'var(--warning)'
  };

  statusEl.textContent = message;
  statusEl.style.borderColor = colors[type] || colors.info;
  statusEl.style.display = 'block';

  // Скрываем через 2 секунды
  setTimeout(() => {
    statusEl.style.display = 'none';
  }, 2000);
}

// ===== ФУНКЦИИ ДЛЯ ИНДИКАТОРОВ =====

// Показ/скрытие индикатора загрузки
function showLoadingIndicator(show) {
  const indicator = document.getElementById('loading-indicator');
  if (!indicator) return;

  if (show) {
    indicator.classList.add('active');
  } else {
    setTimeout(() => {
      indicator.classList.remove('active');
    }, 500); // Небольшая задержка для плавности
  }
}

// Проверка уровня освещения
function checkLightLevel(video) {
  if (!video || video.readyState < 2 || video.videoWidth === 0) return;

  // Инициализируем canvas один раз при первом вызове
  if (!lightCheckCanvas) {
    lightCheckCanvas = document.createElement('canvas');
    lightCheckCtx = lightCheckCanvas.getContext('2d', { willReadFrequently: true });
  }

  // Синхронизируем размер только если изменился
  if (lightCheckCanvas.width !== video.videoWidth || lightCheckCanvas.height !== video.videoHeight) {
    lightCheckCanvas.width = video.videoWidth;
    lightCheckCanvas.height = video.videoHeight;
  }

  // Рисуем текущий кадр
  lightCheckCtx.drawImage(video, 0, 0);

  // Получаем данные пикселей (берём центральный участок 50%x50%)
  const width = lightCheckCanvas.width;
  const height = lightCheckCanvas.height;
  const imageData = lightCheckCtx.getImageData(
    Math.floor(width * 0.25),
    Math.floor(height * 0.25),
    Math.floor(width * 0.5),
    Math.floor(height * 0.5)
  );
  const data = imageData.data;

  // Вычисляем среднюю яркость
  let brightness = 0;
  for (let i = 0; i < data.length; i += 4) {
    // Формула яркости: 0.299*R + 0.587*G + 0.114*B
    brightness += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  brightness /= (data.length / 4);

  // Показываем/скрываем предупреждение
  const warning = document.getElementById('lowlight-warning');
  if (warning) {
    if (brightness < LIGHT_THRESHOLD && !lowLightWarningDismissed) {
      warning.classList.add('active');
    } else {
      warning.classList.remove('active');
    }
  }
}

// Запуск периодической проверки освещения
function startLightCheck(video) {
  // Проверяем каждые 2 секунды
  lightCheckInterval = setInterval(() => {
    checkLightLevel(video);
  }, 2000);

  // Первая проверка через 1 секунду
  setTimeout(() => checkLightLevel(video), 1000);
}

// Остановка проверки освещения
function stopLightCheck() {
  if (lightCheckInterval) {
    clearInterval(lightCheckInterval);
    lightCheckInterval = null;
  }
  // Очищаем переиспользуемый canvas
  if (lightCheckCanvas && lightCheckCtx) {
    lightCheckCtx.clearRect(0, 0, lightCheckCanvas.width, lightCheckCanvas.height);
    lightCheckCanvas = null;
    lightCheckCtx = null;
  }
}

// Закрыть предупреждение о низком освещении
window.dismissLowLightWarning = function () {
  lowLightWarningDismissed = true;
  const warning = document.getElementById('lowlight-warning');
  if (warning) {
    warning.classList.remove('active');
  }
};

// Сброс состояния предупреждения (при перезапуске камеры)
function resetLowLightWarning() {
  lowLightWarningDismissed = false;
}

// ===== УПРАВЛЕНИЕ ЗВУКОМ =====
window.toggleSound = function () {
  soundEnabled = !soundEnabled;

  // Обновляем кнопку
  const btn = document.getElementById('btn-sound-toggle');
  if (btn) {
    btn.textContent = soundEnabled ? '🔊' : '🔇';
    btn.classList.toggle('muted', !soundEnabled);

    // Обновляем текст кнопки через локализацию
    const key = soundEnabled ? 'btnSoundOn' : 'btnSoundOff';
    if (translations[currentLang]?.[key]) {
      btn.setAttribute('data-i18n', key);
      btn.textContent = translations[currentLang][key] + (soundEnabled ? ' 🔊' : ' 🔇');
    }
  }

  // Сохраняем настройку
  localStorage.setItem('soundEnabled', soundEnabled);

  console.log(`🔇 Sound: ${soundEnabled ? 'ON' : 'OFF'}`);
};

// ===== СЛОВАРЬ ПЕРЕВОДОВ =====
const translations = {
  ru: {
    // Страница
    pageTitle: 'МИМИК',
    pageDescription: 'Тренажёр для обучения распознаванию эмоций',
    appTitle: 'МИМИК Тренажёр Эмоций',

    loadingModels: 'Загружаем нейросети... Пожалуйста, подождите',
    lowLightWarning: 'Низкое освещение! Модель может работать неточно',
    dismissWarning: 'Понятно',
    btnSoundOn: '🔊 Звук',
    btnSoundOff: '🔇 Без звука',
    difficultyTooltip: `<strong>Настройка сложности</strong><br>Регулирует строгость распознавания мимики:<br>• <b>Easy (0.2)</b> — прощает лёгкие неточности<br>• <b>Medium (0.5)</b> — стандартный режим<br>• <b>Hard (0.92)</b> и удержание не менее 2 секунд — требует чёткого выражения`,
    walletHint: 'Проверьте номер кошелька перед отправкой - 4100119518078231',
    newRecordSuccess: '🏆 Новый рекорд!',

    btnReviews: '💬 Отзывы',
    reviewsTitle: '💬 Отзывы и предложения',
    reviewsDesc: 'Поделитесь своим опытом использования тренажёра. Ваше мнение помогает проекту расти!',

    onboardingTitle: 'Добро пожаловать в МИМИК!',
    onboardingStep1: 'Нажмите «Начать», чтобы включить камеру',
    onboardingHint1: 'Кнопка внизу блока с камерой',
    onboardingStep2: 'Посмотрите на эмоцию на экране слева',
    onboardingStep3: 'Постарайтесь показать такую же эмоцию перед камерой',
    onboardingStep4: 'При успехе получите баллы! ⭐',
    onboardingStep5: 'Переключайте эмоции стрелками ⬅️ ➡️',
    onboardingStep6: 'Играйте и тренируйтесь вместе в режиме Дуэт 👥',
    btnBack: 'Назад',
    btnNext: 'Далее',
    btnStart: 'Начать!',
    onboardingSkipped: 'Инструкцию можно открыть в любой момент через кнопку «Помощь» 💡',
    btnShowOnboarding: '🎬 Показать инструкцию заново',

    // Кнопки
    btnStartCam: '🎥 Начать',
    btnStopCam: '⏹ Стоп',
    btnReset: '🔄 Сбросить баллы',
    btnCameraSize: '📐 Размер камеры',
    btnPrev: '⬅️',
    btnNext: '➡️',
    difficultyEasy: 'Легко',
    difficultyHard: 'Сложно',

    // Текст
    scoreLabel: '⭐',
    detectedLabel: 'Ваша эмоция:',
    cameraActive: 'Камера активна',
    footerText: '🔒 Все данные обрабатываются локально. Ничего не отправляется на сервер. © 2026 <a href="https://scholar.google.ru/citations?user=6pwhzagAAAAJ&hl=ru" target="_blank" rel="noopener noreferrer" class="author-link">Дмитрий ЛАЗУРЕНКО</a>',

    // Обратная связь
    feedbackCorrect: '✅ Отлично! Правильно!',
    feedbackIncorrect: '🔄 Попробуй ещё раз. Показано:',

    // Эмоции (для отображения)
    emotionHappy: 'Радость',
    emotionSad: 'Грусть',
    emotionAngry: 'Злость',
    emotionSurprised: 'Удивление',
    emotionFearful: 'Страх',
    emotionDisgusted: 'Отвращение',

    // Статусы
    statusNeutral: 'Нейтрально',
    statusHappy: 'Радость',
    statusSad: 'Грусть',
    statusAngry: 'Злость',
    statusSurprised: 'Удивление',
    statusFearful: 'Страх',
    statusDisgusted: 'Отвращение',

    // Уведомления
    notifyCameraError: '❌ Не удалось получить доступ к камере.\n\nПроверьте:\n• Разрешения браузера\n• Подключена ли камера',
    notifyCompactMode: '📐 Компактный режим',
    notifyNormalMode: '📐 Обычный режим',
    notifyScoreReset: 'Сбросить баллы?',

    btnDonate: '❤️ Поддержать',
    donateTitle: 'Поддержать проект',
    donateDesc: 'Использование сайта не требует какой-либо оплаты. Он создаётся одним разработчиком, чтобы помочь детям (в том числе с РАС) лучше понимать эмоции через игру. Ваша поддержка будет дополнительно содействовать росту и развитию проекта, а также позволит добавлять новые эмоции и уровни, улучшать точность распознавания и развивать функции для обучения',
    sbpHint: 'Отсканируйте QR в приложении банка',

    btnFeedback: '✉️ Контакт',
    feedbackTitle: 'Напишите мне, если есть вопросы или предложения',
    btnWrite: '✉️ Написать',

    duelBtn: '👥 Дуэт',
    duelTitle: 'Режим Дуэт',
    duelDesc: 'Покажите эмоцию — партнёр должен повторить! Чем точнее совпадение, тем выше счёт.',
    duelStartBtn: 'Начать игру',
    duelStatusIdle: 'Ждём, пока кто-то покажет эмоцию...',
    duelStatusWaiting: '⏳ Ждём эмоцию от участника {num}...',
    duelStatusTwoPeople: '⚠️ Нужно два человека в кадре',
    duelStatusLost: '⚠️ Участник потерялся в кадре',
    duelResultExcellent: 'Отлично! Вы на одной волне!',
    duelResultGood: '🙂 Неплохо, но можно лучше',
    duelResultFail: '😅 Участник {num} показал {actual} вместо {expected}',
    duelBtnRetry: 'Ещё раз',
    duelBtnExit: 'Выйти',
    playerLeft: 'Участник 1 (слева)',
    playerRight: 'Участник 2 (справа)',
    vsBadge: 'VS',

    // Боковые панели
    btnHelp: "Помощь",
    btnPrivacy: "Приватность",
    helpTitle: "ℹ️ О РАС и тренажёре",
    helpWhatIsAutism: "Что такое РАС?",
    helpAutismDesc: "Расстройство аутистического спектра (РАС) — это особенность развития нервной системы, которая влияет на то, как человек воспринимает мир и взаимодействует с другими. Это не болезнь, а иной способ обработки информации.",
    helpEmotionDifficulty: "Сложности с эмоциями",
    helpEmotionDesc: "Дети с РАС часто испытывают трудности с:",
    helpEmotionItem1: "Распознаванием эмоций на лицах других людей",
    helpEmotionItem2: "Пониманием, что чувствует собеседник",
    helpEmotionItem3: "Выражением собственных эмоций через мимику",
    helpEmotionItem4: "Связью между внутренним состоянием и внешним выражением",
    helpHowTrainerHelps: "Как помогает тренажёр?",
    helpTrainerDesc: "Тренажёр «МИМИК» создан для того, чтобы помочь освоить эти навыки:",
    helpTrainerItem1: "Показываем эмоцию — учимся её узнавать",
    helpTrainerItem2: "Камера распознаёт вашу мимику в реальном времени",
    helpTrainerItem3: "Система баллов мотивирует и показывает прогресс",
    helpTrainerItem4: "Повторение помогает закрепить навык",
    helpHowToUse: "Как пользоваться?",
    helpUseItem1: "Нажмите «Начать»",
    helpUseItem2: "Посмотрите на эмоцию на экране слева",
    helpUseItem3: "Постарайтесь показать такую же эмоцию",
    helpUseItem4: "При успехе получите баллы и ставьте рекорды! ⭐",
    helpUseItem5: "Переключайте эмоции стрелками ⬅️ ➡️",
    helpUseItem6: "Режим Дуэт позволит сделать занятия более интерактивными с наставником",
    helpNote: "💡Совет: Не торопитесь. Каждое повторение — маленький шаг к большому успеху!",
    privacyTitle: "🔒 Политика конфиденциальности",
    privacyDataCollection: "Сбор данных",
    privacyDataDesc: "Тренажёр «МИМИК» работает полностью в вашем браузере. Он не собирает, не хранит и не передаёт никакие персональные данные на серверы.",
    privacyCamera: "Использование камеры",
    privacyCameraDesc: "Камера используется только для распознавания эмоций в реальном времени. Видеопоток обрабатывается локально на вашем устройстве и никуда не отправляется.",
    privacyStorage: "Хранение данных",
    privacyStorageDesc: "На устройстве сохраняются только:",
    privacyStorageItem1: "Выбранный язык интерфейса",
    privacyStorageItem2: "Выбранная тема оформления",
    privacyStorageItem3: "Текущий счёт баллов (до перезагрузки страницы) и максимальный результат прошлых тренировок",
    privacyThirdParty: "Сторонние сервисы",
    privacyThirdPartyDesc: "Приложение использует следующие библиотеки с CDN:",
    privacyThirdPartyNote: "Эти библиотеки загружаются при первом запуске. Они предназначены для машинного обучения в браузере, сегментации тела и распознавания лиц и эмоций. CDN-серверы могут фиксировать факт загрузки файлов, но не получают доступа к вашим данным. Приложение работает как в мобильной, так и в десктопной версии, но может потребоваться некоторое время на загрузку моделей. Просто, немного подождите и всё запустится.",
    privacyChildren: "Данные детей",
    privacyChildrenDesc: "Тренажёр предназначен для использования под наблюдением взрослых. Данные о детях не собираются.",
    privacyChanges: "Изменения политики",
    privacyChangesDesc: "Оставляю за собой право обновлять данную политику. Актуальная версия всегда доступна на данной странице.",
    privacyContact: "По вопросам конфиденциальности или сотрудничества обращайтесь к разработчику - mityasky@ya.ru",
    privacyVersion: "Версия политики: 1.0 | Обновлено: Апрель 2026",
    "emotion-image-alt": "Целевая эмоция"
  },
  en: {
    // Page
    pageTitle: 'MIMIC',
    pageDescription: 'Trainer for learning emotion recognition',
    appTitle: 'MIMIC Emotion Trainer',

    loadingModels: 'Loading neural networks... Please wait',
    lowLightWarning: 'Low light! Model may work inaccurately',
    dismissWarning: 'Got it',
    btnSoundOn: '🔊 Sound',
    btnSoundOff: '🔇 Muted',
    difficultyTooltip: `<strong>Difficulty Settings</strong><br>Adjusts facial recognition strictness:<br>• <b>Easy (0.2)</b> — forgives slight inaccuracies<br>• <b>Medium (0.5)</b> — standard mode<br>• <b>Hard (0.92)</b> and hold for at least 2 seconds — requires clear expression`,
    walletHint: 'Check the wallet number before sending - 4100119518078231',
    newRecordSuccess: '🏆 New Record!',

    btnReviews: '💬 Feedback',
    reviewsTitle: '💬 Reviews & Feedback',
    reviewsDesc: 'Share your experience with the trainer. Your feedback helps the project grow!',

    onboardingTitle: 'Welcome to MIMIC!',
    onboardingStep1: 'Click "Start" to enable camera',
    onboardingHint1: 'Button at the bottom of camera panel',
    onboardingStep2: 'Look at the emotion on the left screen',
    onboardingStep3: 'Try to show the same emotion to the camera',
    onboardingStep4: 'Get points on success! ⭐',
    onboardingStep5: 'Switch emotions with arrows ⬅️ ➡️',
    onboardingStep6: 'Play and train together in Duet mode 👥',
    btnBack: 'Back',
    btnNext: 'Next',
    btnStart: 'Let\'s Go!',
    onboardingSkipped: 'You can open this tutorial anytime via "Help" button 💡',
    btnShowOnboarding: '🎬 Show tutorial again',

    // Buttons
    btnStartCam: '🎥 Start',
    btnStopCam: '⏹ Stop',
    btnReset: '🔄 Reset Score',
    btnCameraSize: '📐 Camera Size',
    btnPrev: '⬅️',
    btnNext: '➡️',
    difficultyEasy: 'Easy',
    difficultyHard: 'Hard',

    // Text
    scoreLabel: '⭐',
    detectedLabel: 'Your emotion:',
    cameraActive: 'Camera active',
    footerText: '🔒 All data is processed locally. Nothing is sent to the server. © 2026 prod by <a href="https://scholar.google.ru/citations?user=6pwhzagAAAAJ&hl=ru" target="_blank" rel="noopener noreferrer" class="author-link">Dmitry LAZURENKO</a>',

    // Feedback
    feedbackCorrect: '✅ Great! Correct!',
    feedbackIncorrect: '🔄 Try again. Shown:',

    // Emotions (for display)
    emotionHappy: 'Happiness',
    emotionSad: 'Sadness',
    emotionAngry: 'Anger',
    emotionSurprised: 'Surprise',
    emotionFearful: 'Fear',
    emotionDisgusted: 'Disgust',

    // Statuses
    statusNeutral: 'Neutral',
    statusHappy: 'Happy',
    statusSad: 'Sad',
    statusAngry: 'Angry',
    statusSurprised: 'Surprised',
    statusFearful: 'Fearful',
    statusDisgusted: 'Disgusted',

    // Notifications
    notifyCameraError: '❌ Could not access camera.\n\nPlease check:\n• Browser permissions\n• Is camera connected',
    notifyCompactMode: '📐 Compact mode',
    notifyNormalMode: '📐 Normal mode',
    notifyScoreReset: 'Reset score?',

    btnFeedback: '✉️ Contact',
    feedbackTitle: 'Write to me if you have questions or suggestions',
    btnWrite: '✉️ Contact',

    duelBtn: '👥 Duet',
    duelTitle: 'Duet Mode',
    duelDesc: 'Show an emotion — your partner must repeat it! The more accurate the match, the higher the score.',
    duelStartBtn: 'Start Game',
    duelStatusIdle: 'Waiting for someone to show an emotion...',
    duelStatusWaiting: '⏳ Waiting for emotion from player {num}...',
    duelStatusTwoPeople: '⚠️ Two people needed in frame',
    duelStatusLost: '⚠️ Player lost in frame',
    duelResultExcellent: 'Great! You are in sync!',
    duelResultGood: '🙂 Not bad, but can be better',
    duelResultFail: '😅 Player {num} showed {actual} instead of {expected}',
    duelBtnRetry: 'Try Again',
    duelBtnExit: 'Exit',
    playerLeft: 'Player 1 (Left)',
    playerRight: 'Player 2 (Right)',
    vsBadge: 'VS',

    btnDonate: '❤️ Support',
    donateTitle: 'Support the project',
    donateDesc: 'Using the site is completely free. It is created by a single developer to help children (including those with ASD) better understand emotions through play. Your support will further contribute to the growth and development of the project, and will help add new emotions and levels, improve recognition accuracy, and expand learning features',
    sbpHint: 'Scan QR in your banking app',

    btnHelp: "Help",
    btnPrivacy: "Privacy",
    helpTitle: "ℹ️ About ASD & Trainer",
    helpWhatIsAutism: "What is ASD?",
    helpAutismDesc: "Autism Spectrum Disorder (ASD) is a neurological developmental difference that affects how a person perceives the world and interacts with others. It's not a disease, but a different way of processing information.",
    helpEmotionDifficulty: "Emotion Difficulties",
    helpEmotionDesc: "Children with ASD often experience challenges with:",
    helpEmotionItem1: "Recognizing emotions on other people's faces",
    helpEmotionItem2: "Understanding what the other person is feeling",
    helpEmotionItem3: "Expressing their own emotions through facial expressions",
    helpEmotionItem4: "Linking internal state with external expression",
    helpHowTrainerHelps: "How does the trainer help?",
    helpTrainerDesc: "MIMIC trainer is designed to help master these skills:",
    helpTrainerItem1: "We show an emotion — you learn to recognize it",
    helpTrainerItem2: "Camera detects your facial expressions in real time",
    helpTrainerItem3: "Scoring system motivates and tracks progress",
    helpTrainerItem4: "Repetition helps consolidate the skill",
    helpHowToUse: "How to use?",
    helpUseItem1: "Click \"Start Cam\"",
    helpUseItem2: "Look at the emotion displayed at the left",
    helpUseItem3: "Try to mirror the same emotion",
    helpUseItem4: "Success earns points and set records! ⭐",
    helpUseItem5: "Switch emotions with arrows ⬅️ ➡️",
    helpUseItem6: "Duet mode makes sessions more interactive with a mentor",
    helpNote: "💡Tip: Take your time. Every repetition is a small step towards big success!",
    privacyTitle: "🔒 Privacy Policy",
    privacyDataCollection: "Data Collection",
    privacyDataDesc: "The MIMIC trainer runs entirely in your browser. We do not collect, store, or transmit any personal data to servers.",
    privacyCamera: "Camera Usage",
    privacyCameraDesc: "The camera is used solely for real-time emotion recognition. The video feed is processed locally on your device and is never sent elsewhere.",
    privacyStorage: "Data Storage",
    privacyStorageDesc: "Only the following are saved locally:",
    privacyStorageItem1: "Selected interface language",
    privacyStorageItem2: "Selected theme",
    privacyStorageItem3: "Current score (until page reload) and the maximum result of previous training sessions",
    privacyThirdParty: "Third-Party Services",
    privacyThirdPartyDesc: "The app uses the following libraries via CDN:",
    privacyThirdPartyNote: "These libraries are loaded on first run. They are designed for machine learning in the browser, body segmentation, and facial and emotion recognition. CDN servers may log the request but do not access your data. The app works on both mobile and desktop versions, but it may take some time to load the models. Just wait a bit, and everything will start working.",
    privacyChildren: "Children's Data",
    privacyChildrenDesc: "The trainer is intended for use under adult supervision. We do not collect data from children.",
    privacyChanges: "Policy Updates",
    privacyChangesDesc: "I reserve the right to update this policy. The latest version is always available in the app.",
    privacyContact: "Contact: For privacy inquiries or collaboration, please contact the developer - mityasky@ya.ru",
    privacyVersion: "Policy Version: 1.0 | Updated: April 2026",
    "emotion-image-alt": "Target Emotion"
  }
};

// ===== ЛОГИКА БОКОВЫХ ПАНЕЛЕЙ =====
window.toggleInfoPanel = function (type) {
  const panel = document.getElementById(`${type}-panel`);
  const isActive = panel.classList.contains('active');

  // Закрываем все открытые панели
  document.querySelectorAll('.info-panel').forEach(p => p.classList.remove('active'));

  // Открываем нужную, если она была закрыта
  if (!isActive) {
    panel.classList.add('active');
  }
};

// Пример: добавляем обработчик на элемент с data-action="show-onboarding"
document.querySelectorAll('[data-action="show-onboarding"]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    Onboarding.showManual();
    // Закрываем панель помощи, если открыта
    document.querySelectorAll('.info-panel').forEach(p => p.classList.remove('active'));
  });
});

// Закрытие панели при клике вне её
document.addEventListener('click', (e) => {
  if (!e.target.closest('.side-panel')) {
    document.querySelectorAll('.info-panel').forEach(p => p.classList.remove('active'));
  }
});

// Текущий язык
let currentLang = 'ru';

// ===== ФУНКЦИЯ ПЕРЕВОДА =====
function translatePage(lang) {
  document.documentElement.lang = lang;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (translations[lang]?.[key]) {

      // СПЕЦИАЛЬНО ДЛЯ ФУТЕРА: разрешаем HTML (ссылки)
      if (key === 'footerText' || key === 'difficultyTooltip') {
        el.innerHTML = translations[lang][key];
      }
      // Для input placeholder
      else if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.hasAttribute('placeholder')) {
        el.placeholder = translations[lang][key];
      }
      // Для alt текста
      else if (el.tagName === 'IMG' && el.hasAttribute('alt')) {
        el.alt = translations[lang][key];
      }
      // Обычный текст (безопасно)
      else {
        el.textContent = translations[lang][key];
      }
    }
  });

  // Обновляем title страницы
  if (translations[lang]?.pageTitle) {
    document.title = translations[lang].pageTitle;
  }

  // Обновляем кнопку языка
  const langBtn = document.getElementById('lang-toggle');
  if (langBtn) {
    langBtn.textContent = lang === 'ru' ? 'RU' : 'ENG';
    langBtn.title = lang === 'ru' ? 'Switch to English' : 'Переключить на русский';
  }

  const duelStartBtn = document.getElementById('duel-start-btn');
  if (duelStartBtn && translations[lang]?.duelStartBtn) {
    duelStartBtn.innerHTML = `🎥 ${translations[lang].duelStartBtn}`;
  }

  // Сохраняем выбор в localStorage
  localStorage.setItem('preferredLang', lang);

  console.log(`🌐 Language switched to: ${lang}`);
}

// ===== ПЕРЕКЛЮЧЕНИЕ ЯЗЫКА =====
function toggleLanguage() {
  currentLang = currentLang === 'ru' ? 'en' : 'ru';
  translatePage(currentLang);

  // ОБНОВЛЯЕМ ТОЛЬКО ТЕКСТ эмоции, не меняя картинку
  const emotion = EMOTIONS[currentEmotionIndex];
  const emotionKey = emotion.key.charAt(0).toUpperCase() + emotion.key.slice(1);
  const emotionName = translations[currentLang]?.[`emotion${emotionKey}`] || emotion.name;

  // Обновляем заголовок эмоции
  document.getElementById('emotion-name').textContent = `${emotionName} ${emotion.emoji}`;

  // Если была активная обратная связь, обновим её текст на новом языке
  const feedbackEl = document.getElementById('feedback');
  if (feedbackEl.textContent && !feedbackEl.classList.contains('correct')) {
    const emotionNameForFeedback = translations[currentLang][`emotion${emotionKey}`];
    feedbackEl.textContent = `${translations[currentLang].feedbackIncorrect} ${emotionNameForFeedback} ${emotion.emoji}`;
  }
}

// ===== ИНИЦИАЛИЗАЦИЯ ЗВУКА =====
function initSound() {
  const saved = localStorage.getItem('soundEnabled');
  if (saved !== null) {
    soundEnabled = saved === 'true';
  }

  // Обновляем кнопку при старте
  const btn = document.getElementById('btn-sound-toggle');
  if (btn) {
    btn.textContent = soundEnabled ? '🔊' : '🔇';
    btn.classList.toggle('muted', !soundEnabled);
    const key = soundEnabled ? 'btnSoundOn' : 'btnSoundOff';
    if (translations[currentLang]?.[key]) {
      btn.setAttribute('data-i18n', key);
    }
  }
}


// ===== ИНИЦИАЛИЗАЦИЯ ЯЗЫКА =====
function initLanguage() {
  const savedLang = localStorage.getItem('preferredLang');
  const browserLang = navigator.language?.split('-')[0] || 'ru';

  // Приоритет: сохранённый > браузерный > русский по умолчанию
  if (savedLang && translations[savedLang]) {
    currentLang = savedLang;
  } else if (translations[browserLang]) {
    currentLang = browserLang;
  } else {
    currentLang = 'ru';
  }

  // Применяем перевод
  translatePage(currentLang);

  // Добавляем обработчик кнопки
  const langBtn = document.getElementById('lang-toggle');
  if (langBtn) {
    langBtn.addEventListener('click', toggleLanguage);
  }

  console.log(`🌐 Language initialized: ${currentLang}`);
}

// ===== ИНИЦИАЛИЗАЦИЯ ПОЛЗУНКА СЛОЖНОСТИ =====
function initDifficultySlider() {
  const slider = document.getElementById('difficulty-slider');
  const tooltip = document.getElementById('diff-tooltip');
  const infoBtn = document.getElementById('diff-info-btn');

  if (!slider) return;

  // Обновление порога при перетаскивании
  slider.addEventListener('input', (e) => {
    const level = parseInt(e.target.value);
    detectionThreshold = DIFFICULTY_THRESHOLDS[level];
  });

  // Показ/скрытие подсказки по кнопке ℹ️
  if (infoBtn && tooltip) {
    infoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      tooltip.classList.toggle('active');
    });
    // Закрыть при клике в любом месте страницы
    document.addEventListener('click', () => tooltip.classList.remove('active'));
    tooltip.addEventListener('click', (e) => e.stopPropagation()); // Не закрывать при клике внутри
  }
}

// ===== МОДАЛЬНОЕ ОКНО ОБРАТНОЙ СВЯЗИ =====
document.addEventListener('DOMContentLoaded', () => {
  const feedbackBtn = document.getElementById('feedback-btn');
  const feedbackModal = document.getElementById('feedback-modal');
  const feedbackClose = feedbackModal?.querySelector('.modal-close');
  const feedbackWriteBtn = document.getElementById('feedback-write-btn');

  if (!feedbackBtn || !feedbackModal) return;

  // Открытие
  feedbackBtn.addEventListener('click', () => feedbackModal.classList.add('active'));

  // Закрытие
  const closeModal = () => feedbackModal.classList.remove('active');
  feedbackClose?.addEventListener('click', closeModal);
  feedbackModal.addEventListener('click', (e) => { if (e.target === feedbackModal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // Кнопка "Написать" -> открывает почтовый клиент
  feedbackWriteBtn?.addEventListener('click', () => {
    const subject = encodeURIComponent('MIMIC App');
    window.location.href = `mailto:mityasky@ya.ru?subject=${subject}`;
  });
});

// ===== МОДАЛЬНОЕ ОКНО ДОНАТА =====
document.addEventListener('DOMContentLoaded', () => {
  const donateBtn = document.getElementById('donate-btn');
  const donateModal = document.getElementById('donate-modal');
  const donateClose = donateModal?.querySelector('.modal-close');
  const sbpToggleBtn = document.getElementById('sbp-toggle-btn');
  const sbpContainer = document.getElementById('sbp-qr-container');

  if (donateBtn && donateModal) {
    // Открытие
    donateBtn.addEventListener('click', () => donateModal.classList.add('active'));

    // Закрытие
    const closeDonate = () => donateModal.classList.remove('active');
    donateClose?.addEventListener('click', closeDonate);
    donateModal.addEventListener('click', (e) => { if (e.target === donateModal) closeDonate(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && donateModal.classList.contains('active')) closeDonate(); });
  }
});

// ===== ONBOARDING / ИНСТРУКЦИЯ ПРИ ПЕРВОМ ЗАПУСКЕ =====

const Onboarding = (() => {
  let currentStep = 1;
  const totalSteps = 6;
  const STORAGE_KEY = 'mimic_onboarding_seen';

  // Проверка: показывать ли инструкцию
  function shouldShow() {
    return !localStorage.getItem(STORAGE_KEY);
  }

  // Показать оверлей
  function show() {
    const overlay = document.getElementById('onboarding-overlay');
    if (!overlay) return;

    overlay.hidden = false;
    currentStep = 1;
    updateStep();

    // Блокируем прокрутку фона
    document.body.style.overflow = 'hidden';

    console.log('🎬 Onboarding started');
  }

  // Скрыть оверлей
  function hide() {
    const overlay = document.getElementById('onboarding-overlay');
    if (!overlay) return;

    overlay.hidden = true;

    // Разблокируем прокрутку
    document.body.style.overflow = '';

    // Запоминаем, что пользователь прошёл инструкцию
    localStorage.setItem(STORAGE_KEY, 'true');

    console.log('✅ Onboarding completed');
  }

  // Обновить отображение шага
  function updateStep() {
    // Скрыть все шаги
    document.querySelectorAll('.onboarding-step').forEach(step => {
      step.classList.remove('active');
    });

    // Показать текущий
    const activeStep = document.querySelector(`.onboarding-step[data-step="${currentStep}"]`);
    if (activeStep) {
      activeStep.classList.add('active');
    }

    // Обновить точки-индикаторы
    document.querySelectorAll('.dot').forEach(dot => {
      dot.classList.remove('active');
    });
    const activeDot = document.querySelector(`.dot[data-dot="${currentStep}"]`);
    if (activeDot) {
      activeDot.classList.add('active');
    }

    // Управление кнопками
    const prevBtn = document.getElementById('onboarding-prev');
    const nextBtn = document.getElementById('onboarding-next');
    const finishBtn = document.getElementById('onboarding-finish');

    if (prevBtn) prevBtn.disabled = (currentStep === 1);
    if (nextBtn) nextBtn.hidden = (currentStep === totalSteps);
    if (finishBtn) finishBtn.hidden = (currentStep !== totalSteps);

    // Обновляем текст кнопок через локализацию
    if (nextBtn && translations[currentLang]?.btnNext) {
      nextBtn.textContent = translations[currentLang].btnNext;
    }
    if (finishBtn && translations[currentLang]?.btnStart) {
      finishBtn.textContent = translations[currentLang].btnStart;
    }
  }

  // Переход к следующему шагу
  function next() {
    if (currentStep < totalSteps) {
      currentStep++;
      updateStep();
    }
  }

  // Переход к предыдущему шагу
  function prev() {
    if (currentStep > 1) {
      currentStep--;
      updateStep();
    }
  }

  // Инициализация обработчиков
  function init() {
    // Кнопка "Пропустить" (крестик)
    const skipBtn = document.getElementById('onboarding-skip');
    if (skipBtn) {
      skipBtn.addEventListener('click', () => {
        hide();
        // Мягкое уведомление, что инструкцию можно открыть позже
        if (translations[currentLang]?.onboardingSkipped) {
          showTemporaryHint(translations[currentLang].onboardingSkipped);
        }
      });
    }

    // Кнопка "Далее"
    const nextBtn = document.getElementById('onboarding-next');
    if (nextBtn) {
      nextBtn.addEventListener('click', next);
    }

    // Кнопка "Назад"
    const prevBtn = document.getElementById('onboarding-prev');
    if (prevBtn) {
      prevBtn.addEventListener('click', prev);
    }

    // Кнопка "Начать!" (финиш)
    const finishBtn = document.getElementById('onboarding-finish');
    if (finishBtn) {
      finishBtn.addEventListener('click', () => {
        hide();
        // Опционально: автоматически кликнуть по кнопке "Начать" камеры
        // setTimeout(() => {
        //   const startCamBtn = document.getElementById('btn-start-cam');
        //   if (startCamBtn && !startCamBtn.disabled) {
        //     startCamBtn.click();
        //   }
        // }, 300);
      });
    }

    // Клик по точкам-индикаторам
    document.querySelectorAll('.dot').forEach(dot => {
      dot.addEventListener('click', (e) => {
        const step = parseInt(e.target.dataset.dot);
        if (step && step >= 1 && step <= totalSteps) {
          currentStep = step;
          updateStep();
        }
      });
    });

    // Закрытие по клику вне модального окна
    const overlay = document.getElementById('onboarding-overlay');
    const modal = document.querySelector('.onboarding-modal');
    if (overlay && modal) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          hide();
        }
      });
    }

    // Закрытие по Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay?.hidden) {
        hide();
      }
    });

    // Авто-показ при загрузке, если нужно
    if (shouldShow()) {
      // Небольшая задержка, чтобы страница успела отрендериться
      setTimeout(show, 500);
    }
  }

  // Вспомогательная функция для временной подсказки
  function showTemporaryHint(text) {
    const hint = document.createElement('div');
    hint.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-card);
      color: var(--text);
      padding: 12px 20px;
      border-radius: 12px;
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      font-size: 13px;
      z-index: 15000;
      animation: hintFade 3s ease forwards;
      max-width: 90%;
      text-align: center;
    `;
    hint.textContent = text;
    document.body.appendChild(hint);

    // Добавляем анимацию, если ещё нет
    if (!document.getElementById('hint-anim-style')) {
      const style = document.createElement('style');
      style.id = 'hint-anim-style';
      style.textContent = `
        @keyframes hintFade {
          0%, 100% { opacity: 0; transform: translateX(-50%) translateY(10px); }
          10%, 90% { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `;
      document.head.appendChild(style);
    }

    setTimeout(() => hint.remove(), 3000);
  }

  // Публичный метод для ручного показа (например, из кнопки "Помощь")
  function showManual() {
    // Показываем даже если уже видели
    localStorage.removeItem(STORAGE_KEY);
    show();
  }

  return {
    init,
    showManual,
    isVisible: () => !document.getElementById('onboarding-overlay')?.hidden
  };
})();

// Инициализация onboarding после загрузки DOM
document.addEventListener('DOMContentLoaded', () => {
  Onboarding.init();
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && e.key === 'o') {
    e.preventDefault();
    localStorage.removeItem('mimic_onboarding_seen');
    Onboarding.showManual();
    console.log('🔄 Onboarding reset (dev mode)');
  }
});

// ===== МОДАЛЬНОЕ ОКНО ОТЗЫВОВ (CUSDIS) =====
document.addEventListener('DOMContentLoaded', () => {
  const reviewsBtn = document.getElementById('reviews-btn');
  const reviewsModal = document.getElementById('reviews-modal');
  const reviewsClose = reviewsModal?.querySelector('.modal-close');

  if (!reviewsBtn || !reviewsModal) return;

  // Открытие модалки
  reviewsBtn.addEventListener('click', () => {
    reviewsModal.classList.add('active');
    // Синхронизируем тему Cusdis при открытии
    syncCusdisTheme();
    // принудительный ресайз виджета после анимации
    setTimeout(() => {
      if (window.CUSDIS && typeof window.CUSDIS.resize === 'function') {
        window.CUSDIS.resize();
      }
    }, 300); // Ждём завершения анимации появления модалки
  });

  // Закрытие
  const closeReviews = () => reviewsModal.classList.remove('active');
  reviewsClose?.addEventListener('click', closeReviews);
  reviewsModal.addEventListener('click', (e) => {
    if (e.target === reviewsModal) closeReviews();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && reviewsModal.classList.contains('active')) closeReviews();
  });
});

// Вспомогательная функция: синхронизация темы Cusdis
function syncCusdisTheme() {
  if (!window.CUSDIS) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  window.CUSDIS.setTheme(isDark ? 'dark' : 'light');
}

function showRecordNotification() {
  const notif = document.getElementById('record-notification');
  if (!notif) return;

  notif.hidden = false;
  // Сброс анимации для повторного запуска
  void notif.offsetHeight;
  notif.style.animation = 'recordPopIn 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards';

  // Автоскрытие через 3 сек
  clearTimeout(notif._hideTimer);
  notif._hideTimer = setTimeout(() => {
    notif.hidden = true;
  }, 3000);
}

function resetHighScore() {
  if (confirm(translations[currentLang].confirmResetRecord || 'Сбросить рекорд?')) {
    highScore = 0;
    localStorage.setItem('mimicHighScore', 0);
    updateScoreDisplay();
    showStatus(translations[currentLang].recordReset || '🗑️ Рекорд сброшен!', 'info');
  }
}

// Комбинация клавиш: Ctrl + Alt + R
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    resetHighScore();
  }
  // Сохраняем вашу старую комбинацию для онбординга
  if (e.ctrlKey && e.altKey && e.key === 'o') {
    e.preventDefault();
    localStorage.removeItem('mimic_onboarding_seen');
    Onboarding.showManual();
    console.log('🔄 Onboarding reset (dev mode)');
  }
});

// ===== ЛОГИКА РЕЖИМА ДУЭТ =====
let duelStream = null;
let duelVideo = null;
let duelAnimFrame = null;
let duelState = 'idle'; // idle, waiting_second, result
let lockedEmotion = null; // эмоция первого участника, который показал эмоцию
let firstParticipantIndex = null; // 0 или 1 - кто первый показал эмоцию

// Вспомогательная функция для форматирования статуса с подстановкой чисел
function formatStatus(key, params = {}) {
  let text = translations[currentLang]?.[key] || key;
  for (const [k, v] of Object.entries(params)) {
    text = text.replace(`{${k}}`, v);
  }
  return text;
}

window.openDuelMode = async function () {
  const modal = document.getElementById('duel-modal');

  if (!emotionModelLoaded) {
    showLoadingIndicator(true);
    try {
      await loadEmotionModels();
    } catch (e) {
      console.error('❌ Failed to load emotion models:', e);
      alert('Не удалось загрузить модели распознавания. Попробуйте обновить страницу.');
      showLoadingIndicator(false);
      return;
    }
    showLoadingIndicator(false);
  }

  // Обновляем тексты модалки при открытии
  const statusEl = document.getElementById('duel-status-text');
  const startBtn = document.getElementById('duel-start-btn');
  const p1Label = document.querySelector('.player-score.p1');
  const p2Label = document.querySelector('.player-score.p2');
  const vsBadge = document.querySelector('.vs-badge');

  if (statusEl) statusEl.textContent = translations[currentLang]?.duelStatusIdle || 'Waiting...';
  if (startBtn) {
    startBtn.innerHTML = `🎥 ${translations[currentLang]?.duelStartBtn || 'Start Game'}`;
    startBtn.setAttribute('data-i18n', 'duelStartBtn');
  }
  if (p1Label) p1Label.textContent = translations[currentLang]?.playerLeft || 'Player 1 (Left)';
  if (p2Label) p2Label.textContent = translations[currentLang]?.playerRight || 'Player 2 (Right)';
  if (vsBadge) vsBadge.textContent = translations[currentLang]?.vsBadge || 'VS';


  modal.classList.add('active');
  modal.style.display = 'flex';
  duelState = 'idle';
  lockedEmotion = null;
  firstParticipantIndex = null;
  updateDuelUI();
};

// Закрытие модалки
window.closeDuelMode = function () {
  const modal = document.getElementById('duel-modal');
  modal.classList.remove('active');
  setTimeout(() => { modal.style.display = 'none'; }, 300);
  stopDuelCamera();
};

// Старт камеры для дуэта
window.startDuelCamera = async function () {
  const video = document.getElementById('duel-video');
  const startBtn = document.getElementById('duel-start-btn');

  if (startBtn) startBtn.style.display = 'none';

  if (!emotionModelLoaded) {
    await loadEmotionModels();
  }

  if (navigator.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: 'user' }
      });

      duelStream = stream;
      duelVideo = video;
      video.srcObject = stream;
      video.style.display = 'block';

      video.onloadedmetadata = () => {
        video.play().then(() => runDuelLoop()).catch(e => console.error('Video play error:', e));
      };
    } catch (err) {
      console.error('Camera error:', err);
      alert(translations[currentLang]?.notifyCameraError || 'Camera error');
      if (startBtn) startBtn.style.display = 'block';
    }
  }
};

// Остановка камеры
function stopDuelCamera() {
  if (duelAnimFrame) { cancelAnimationFrame(duelAnimFrame); duelAnimFrame = null; }
  if (duelStream) { duelStream.getTracks().forEach(t => t.stop()); duelStream = null; }
  if (duelVideo) { duelVideo.srcObject = null; duelVideo.style.display = 'none'; }

  duelState = 'idle';
  lockedEmotion = null;
  firstParticipantIndex = null;

  const startBtn = document.getElementById('duel-start-btn');
  if (startBtn) startBtn.style.display = 'block';
  const statusEl = document.getElementById('duel-status-text');
  if (statusEl) statusEl.textContent = '';
}

// ===== ГЛАВНЫЙ ЦИКЛ ДУЭТА =====
async function runDuelLoop() {
  if (!duelVideo || duelVideo.paused || duelVideo.ended) return;

  if (!emotionModelLoaded || !faceapi.nets.tinyFaceDetector.isLoaded) {
    await loadEmotionModels();
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  try {
    const detections = await faceapi.detectAllFaces(
      duelVideo,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.6 })
    ).withFaceLandmarks().withFaceExpressions();

    if (detections.length >= 2) {
      detections.sort((a, b) => a.detection.box.x - b.detection.box.x);
      const expressions = [detections[0].expressions, detections[1].expressions];
      processDuelLogic(expressions);
    } else {
      if (duelState === 'idle' || duelState === 'waiting_second') {
        setStatusText(formatStatus('duelStatusTwoPeople'));
      }
    }
  } catch (e) {
    if (!e.message?.includes('backend')) console.error('❌ Duel detection error:', e);
  }

  if (duelState !== 'result') {
    duelAnimFrame = requestAnimationFrame(runDuelLoop);
  }
}

// Логика сравнения — кто первый показал эмоцию, тот и "задаёт тон"
function processDuelLogic(expressions) {
  const dom0 = getDominant(expressions[0]);
  const dom1 = getDominant(expressions[1]);

  if (duelState === 'idle') {
    if (dom0.key !== 'neutral' && dom0.val > 0.6) {
      lockedEmotion = dom0.key;
      firstParticipantIndex = 0;
      duelState = 'waiting_second';
      setStatusText(`✨ ${translations[currentLang]?.playerLeft || 'Player 1'}: ${translateEmotion(dom0.key)}! ${translations[currentLang]?.duelStatusWaiting?.replace('{num}', '2') || 'Waiting...'}`);
      return;
    }
    if (dom1.key !== 'neutral' && dom1.val > 0.6) {
      lockedEmotion = dom1.key;
      firstParticipantIndex = 1;
      duelState = 'waiting_second';
      setStatusText(`✨ ${translations[currentLang]?.playerRight || 'Player 2'}: ${translateEmotion(dom1.key)}! ${translations[currentLang]?.duelStatusWaiting?.replace('{num}', '1') || 'Waiting...'}`);
      return;
    }
    setStatusText(formatStatus('duelStatusIdle'));
  }
  else if (duelState === 'waiting_second') {
    const secondIndex = firstParticipantIndex === 0 ? 1 : 0;
    const secondDom = secondIndex === 0 ? dom0 : dom1;

    if (secondDom.key !== 'neutral' && secondDom.val > 0.4) {
      calculateDuelScore(lockedEmotion, expressions[secondIndex]);
    } else {
      setStatusText(formatStatus('duelStatusWaiting', { num: secondIndex + 1 }));
    }
  }
}

// Подсчет очков
function calculateDuelScore(targetEmotion, p2Expressions) {
  const p2Dom = getDominant(p2Expressions).key;
  let score = 0;

  if (p2Dom === targetEmotion) {
    score = Math.round(p2Expressions[targetEmotion] * 10);
    if (score > 10) score = 10;
  }
  showDuelResult(score, targetEmotion, p2Dom);
}

function showDuelResult(score, expected, actual) {
  duelState = 'result';
  cancelAnimationFrame(duelAnimFrame);

  const resCard = document.getElementById('duel-result-card');
  const resScore = document.getElementById('result-score');
  const resText = document.getElementById('result-text');

  resScore.textContent = `${score}/10`;

  const t = translations[currentLang];
  if (score >= 8) {
    resText.textContent = t?.duelResultExcellent || '🎉 Great!';
    resScore.style.color = '#2ecc71';
  } else if (score >= 5) {
    resText.textContent = t?.duelResultGood || '🙂 Good';
    resScore.style.color = '#f1c40f';
  } else {
    const secondIdx = firstParticipantIndex === 0 ? 2 : 1;
    resText.textContent = formatStatus('duelResultFail', {
      num: secondIdx,
      actual: translateEmotion(actual),
      expected: translateEmotion(expected)
    });
    resScore.style.color = '#e74c3c';
  }

  // Обновляем текст кнопок результата
  const retryBtn = resCard.querySelector('.duel-btn-primary');
  const exitBtn = resCard.querySelector('.duel-btn-secondary');
  if (retryBtn) {
    retryBtn.innerHTML = `🔄 ${t?.duelBtnRetry || 'Retry'}`;
    retryBtn.setAttribute('data-i18n', 'duelBtnRetry');
  }
  if (exitBtn) {
    exitBtn.innerHTML = `🚪 ${t?.duelBtnExit || 'Exit'}`;
    exitBtn.setAttribute('data-i18n', 'duelBtnExit');
  }

  resCard.classList.remove('hidden');
}


// Утилиты
window.nextDuelRound = function () {
  const resCard = document.getElementById('duel-result-card');
  resCard.classList.add('hidden');
  duelState = 'idle';
  lockedEmotion = null;
  firstParticipantIndex = null;
  runDuelLoop();
};

function setStatusText(text) {
  const el = document.getElementById('duel-status-text');
  if (el) el.textContent = text;
}

function getDominant(expressions) {
  let maxVal = 0, maxKey = 'neutral';
  for (const [key, val] of Object.entries(expressions)) {
    if (val > maxVal) { maxVal = val; maxKey = key; }
  }
  return { key: maxKey, val: maxVal };
}

function translateEmotion(key) {
  const mapRu = { happy: 'Радость', sad: 'Грусть', angry: 'Злость', surprised: 'Удивление', fearful: 'Страх', disgusted: 'Отвращение', neutral: 'Нейтрально' };
  const mapEn = { happy: 'Happy', sad: 'Sad', angry: 'Angry', surprised: 'Surprised', fearful: 'Fear', disgusted: 'Disgust', neutral: 'Neutral' };
  return currentLang === 'ru' ? (mapRu[key] || key) : (mapEn[key] || key);
}

// ===== ОБНОВЛЕНИЕ ИНТЕРФЕЙСА ДУЭТ-РЕЖИМА =====
function updateDuelUI() {
  const statusEl = document.getElementById('duel-status-text');
  const resultCard = document.getElementById('duel-result-card');
  if (!statusEl) return;
  if (resultCard) resultCard.classList.add('hidden');

  const t = translations[currentLang];
  switch (duelState) {
    case 'idle':
      statusEl.textContent = t?.duelDesc || 'Show an emotion — your partner must repeat it! The more accurate the match, the higher the score.';
      break;
    case 'waiting_second':
      const waitingFor = firstParticipantIndex === 0 ? 2 : 1;
      statusEl.textContent = formatStatus('duelStatusWaiting', { num: waitingFor });
      break;
    case 'result':
      // Текст уже установлен в showDuelResult
      break;
  }
}
