// Language utilities - agnostic approach without predefined lists

/**
 * Get flag emoji from language code (ISO 639-1)
 * Uses regional indicator symbols to generate flag emojis
 */
function getFlagEmoji(langCode) {
    // Map language codes to country codes for flag emojis
    const langToCountry = {
        'en': 'GB', 'fr': 'FR', 'es': 'ES', 'de': 'DE', 'it': 'IT',
        'pt': 'PT', 'nl': 'NL', 'pl': 'PL', 'ru': 'RU', 'ja': 'JP',
        'zh': 'CN', 'ar': 'SA', 'ko': 'KR', 'sv': 'SE', 'no': 'NO',
        'da': 'DK', 'fi': 'FI', 'cs': 'CZ', 'el': 'GR', 'he': 'IL',
        'hi': 'IN', 'tr': 'TR', 'uk': 'UA', 'vi': 'VN', 'th': 'TH'
    };

    const countryCode = langToCountry[langCode] || langCode.toUpperCase();

    // Convert country code to flag emoji using regional indicator symbols
    return countryCode
        .toUpperCase()
        .split('')
        .map(char => String.fromCodePoint(127397 + char.charCodeAt(0)))
        .join('');
}

/**
 * Get language label with flag
 * Format: "🇫🇷 fr" (flag + code)
 * Agnostic: works with any ISO 639-1 language code
 */
function getLanguageLabel(langCode) {
    if (!langCode) return '';
    const flag = getFlagEmoji(langCode);
    return `${flag} ${langCode}`;
}

/** Languages a community server can declare, by code, with their native name. */
export const SERVER_LANGUAGES = {
    fr: 'Français', en: 'English', es: 'Español', de: 'Deutsch', it: 'Italiano',
    pt: 'Português', nl: 'Nederlands', pl: 'Polski', ru: 'Русский', ja: '日本語',
    zh: '中文', ar: 'العربية'
};

// Expose globally for templates
window.SERVER_LANGUAGES = SERVER_LANGUAGES;
window.getFlagEmoji = getFlagEmoji;
window.getLanguageLabel = getLanguageLabel;

// Helper to parse JSON arrays safely
export function parseJsonArray(value, defaultValue = []) {
    if (!value) return defaultValue;
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : defaultValue;
        } catch (e) {
            console.error('Failed to parse JSON array:', e);
            return defaultValue;
        }
    }
    return defaultValue;
}

window.parseJsonArray = parseJsonArray;
