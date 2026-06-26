// Профиль модели Zeta 2.1 фиксирует только реальные runtime-пределы, чтобы другие слои не хардкодили их повторно.
export interface ZetaModelProfile {
    id: string;
    model: string;
    contextTokens: number;
    maxOutputTokens: number;
    temperature: number;
}

// Единственный профиль zeta-2.1 хранится как const-объект, чтобы не генерировать лишний рантайм-код через enum.
export const ZETA_PROFILE: ZetaModelProfile = {
    id: 'zeta-2.1',
    model: 'zeta-2.1',
    contextTokens: 32768,
    maxOutputTokens: 512,
    temperature: 0,
};

// Пустая строка в preferences означает «использовать дефолтное имя zeta21-модели из профиля». 
export function zetaRequestModelName(configuredName: string): string {
    const trimmed = configuredName.trim();
    return trimmed.length > 0 ? trimmed : ZETA_PROFILE.model;
}
