import { XCStrings, TranslationRequest } from '../types';

export interface StringAnalysisResult {
  translationRequests: TranslationRequest[];
  translationChanges: {
    added: string[];
    updated: string[];
    staleRemoved: string[];
  };
  stringTranslationMap: Map<string, { languages: string[], isNew: Map<string, boolean> }>;
  modifiedXcstringsData: XCStrings;
  xcstringsModified: boolean;
  fallbackToKeyCount: number;
}

/**
 * Analyzes XCStrings data to identify strings that need translation and prepares translation requests.
 * This is the core business logic that determines what translations are needed.
 * 
 * @param xcstringsData The parsed XCStrings data
 * @param targetLanguages Array of target language codes to translate to
 * @returns Analysis result containing translation requests and change tracking
 */
export function analyzeStringsForTranslation(
  xcstringsData: XCStrings,
  targetLanguages: string[],
  sourceLanguageForText?: string
): StringAnalysisResult {
  // Create a deep copy to avoid modifying the original
  const modifiedXcstringsData = JSON.parse(JSON.stringify(xcstringsData));
  
  const translationRequests: TranslationRequest[] = [];
  const translationChanges: { added: string[]; updated: string[]; staleRemoved: string[]; } = { 
    added: [], 
    updated: [], 
    staleRemoved: [] 
  };
  const stringTranslationMap: Map<string, { languages: string[], isNew: Map<string, boolean> }> = new Map();
  let xcstringsModified = false;
  let fallbackToKeyCount = 0;

  for (const key in modifiedXcstringsData.strings) {
    const currentStringEntry = modifiedXcstringsData.strings[key];
    
    // Remove stale entries
    if (currentStringEntry.extractionState === 'stale') {
      delete modifiedXcstringsData.strings[key];
      xcstringsModified = true;
      translationChanges.staleRemoved.push(key);
      continue;
    }

    // Skip strings marked as shouldTranslate=false
    if (currentStringEntry.shouldTranslate === false) {
      continue;
    }

    // Ensure localizations object exists to avoid undefined checks later
    if (!currentStringEntry.localizations) {
      currentStringEntry.localizations = {};
    }

    const languagesNeeded: string[] = [];
    const isNewMap: Map<string, boolean> = new Map();

    // Check each target language to see if translation is needed
    for (const lang of targetLanguages) {
      const targetLocalization = currentStringEntry.localizations[lang];
      const targetStringUnit = targetLocalization?.stringUnit;
      const isMissingOrEmpty = !targetStringUnit || !targetStringUnit.value || targetStringUnit.value.trim().length === 0;
      const isNeedsReview = targetStringUnit?.state === 'needs_review';

      const needsTranslationForLang = isMissingOrEmpty || isNeedsReview;

      if (needsTranslationForLang) {
        const isNewTranslation = !targetLocalization;
        languagesNeeded.push(lang);
        isNewMap.set(lang, isNewTranslation);
      }
    }

    // If any languages need translation, add to requests
    if (languagesNeeded.length > 0) {
      const sourceTextCandidate = sourceLanguageForText
        ? currentStringEntry.localizations?.[sourceLanguageForText]?.stringUnit?.value?.trim()
        : undefined;
      const useKeyFallback = !sourceTextCandidate || sourceTextCandidate.length === 0;
      if (useKeyFallback) {
        fallbackToKeyCount += 1;
      }
      const sourceText = useKeyFallback ? key : (sourceTextCandidate as string);

      translationRequests.push({
        key: key,
        text: sourceText,
        targetLanguages: languagesNeeded,
        comment: currentStringEntry.comment
      });
      stringTranslationMap.set(key, { languages: languagesNeeded, isNew: isNewMap });
    }
  }

  return {
    translationRequests,
    translationChanges,
    stringTranslationMap,
    modifiedXcstringsData,
    xcstringsModified,
    fallbackToKeyCount
  };
} 