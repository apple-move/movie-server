/**
 * Guess the language code of a subtitle file from its name.
 * Handles "movie.en.srt", "movie.eng.srt", "movie.bengali.srt" and friends.
 */
const CODE_MAP = {
  eng: 'en',
  english: 'en',
  ben: 'bn',
  bangla: 'bn',
  bengali: 'bn',
  hin: 'hi',
  hindi: 'hi',
  spa: 'es',
  spanish: 'es',
  fre: 'fr',
  french: 'fr',
  ger: 'de',
  german: 'de',
  ita: 'it',
  italian: 'it',
  jpn: 'ja',
  japanese: 'ja',
  kor: 'ko',
  korean: 'ko',
  chi: 'zh',
  chinese: 'zh',
  por: 'pt',
  portuguese: 'pt',
  rus: 'ru',
  russian: 'ru',
  ara: 'ar',
  arabic: 'ar',
  dut: 'nl',
  dutch: 'nl',
  tur: 'tr',
  turkish: 'tr',
  pol: 'pl',
  polish: 'pl',
  swe: 'sv',
  swedish: 'sv',
  nor: 'no',
  dan: 'da',
  danish: 'da',
  fin: 'fi',
  finnish: 'fi',
  ind: 'id',
  indonesian: 'id',
  tha: 'th',
  thai: 'th',
  vie: 'vi',
  vietnamese: 'vi',
};

const ISO_CODES = new Set([
  'en', 'bn', 'hi', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh',
  'pt', 'ru', 'ar', 'nl', 'tr', 'pl', 'sv', 'no', 'da', 'fi',
  'id', 'th', 'vi', 'cs', 'el', 'he', 'hu', 'ro', 'sk', 'bg',
  'uk', 'lt', 'lv', 'et', 'sl', 'hr', 'sr', 'fa', 'ms', 'ta',
]);

export function detectLanguage(name) {
  const raw = String(name || '');

  // "movie.en.srt" / "movie.en.forced.srt"
  const iso = /\.([a-z]{2,3})(?:\.[a-z]{2,8})?\.(srt|vtt|ass|ssa|sub)$/i.exec(raw);
  if (iso) {
    const code = iso[1].toLowerCase();
    if (ISO_CODES.has(code)) return code;
    if (CODE_MAP[code]) return CODE_MAP[code];
  }

  // "movie.english.srt"
  const word = /\.(eng|english|ben|bangla|bengali|hin|hindi|spa|spanish|fre|french|ger|german|ita|italian|jpn|japanese|kor|korean|por|portuguese|rus|russian|ara|arabic|dut|dutch|tur|turkish|pol|polish|swe|swedish|nor|dan|danish|fin|finnish|ind|indonesian|tha|thai|vie|vietnamese)\./i.exec(raw);
  if (word) return CODE_MAP[word[1].toLowerCase()] || 'en';

  return 'en';
}
