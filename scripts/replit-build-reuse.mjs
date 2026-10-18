// A second Replit deployment build can see only the exact tracked files that
// the first build intentionally removed or regenerated. Any source edit fails.
export const isExpectedBuildCleanupStatus = (status) =>
  status.length > 0 && status.some((line) => /^ D (?:artifacts|reports|models|datasets|coverage|tmp|test-results|\.cache)\//u.test(line)) &&
  status.every((line) =>
    /^ D (?:artifacts|reports|models|datasets|coverage|tmp|test-results|\.cache)\//u.test(line) ||
    line === " M client/src/lib/docs/docMetadata.generated.ts");
