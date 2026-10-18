export function assessUnga81ExtractedText(text) {
  if (typeof text !== "string") {
    return { status: "missing_or_changed", reasonCodes: ["text_unavailable"], characterCount: 0,
      controlRatio: null, replacementRatio: null, letterRatio: null };
  }
  const characterCount = text.length;
  const controlRatio = characterCount ? [...text].filter((character) =>
    character.charCodeAt(0) < 32 && !"\t\n\r\f".includes(character)).length / characterCount : 0;
  const replacementRatio = characterCount ? [...text].filter((character) => character === "\uFFFD").length / characterCount : 0;
  const nonWhitespace = [...text].filter((character) => !/\s/u.test(character));
  const letterRatio = nonWhitespace.length ? nonWhitespace.filter((character) => /\p{L}/u.test(character)).length / nonWhitespace.length : 0;
  const reasonCodes = [
    ...(characterCount < 80 ? ["too_little_extracted_text"] : []),
    ...(controlRatio > 0.005 ? ["embedded_control_characters"] : []),
    ...(replacementRatio > 0.005 ? ["replacement_characters"] : []),
    ...(letterRatio < 0.25 ? ["low_letter_ratio"] : []),
  ];
  const status = characterCount < 80 || controlRatio > 0.005 ? "unusable"
    : replacementRatio > 0.005 || letterRatio < 0.25 ? "degraded_review_needed" : "screenable";
  return { status, reasonCodes, characterCount,
    controlRatio: Number(controlRatio.toFixed(4)), replacementRatio: Number(replacementRatio.toFixed(4)),
    letterRatio: Number(letterRatio.toFixed(4)) };
}
