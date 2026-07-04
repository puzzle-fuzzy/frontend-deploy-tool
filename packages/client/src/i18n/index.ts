import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector/cjs';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zh from './locales/zh.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, zh: { translation: zh } },
    fallbackLng: 'zh',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  });

i18n.on('languageChanged', (language) => {
  document.documentElement.lang = language.startsWith('zh') ? 'zh-CN' : 'en';
});

document.documentElement.lang = i18n.language.startsWith('zh') ? 'zh-CN' : 'en';

export default i18n;
