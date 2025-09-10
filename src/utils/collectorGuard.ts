export function allowEnrichment(): boolean {
  try {
    // Default policy: enrichment disabled unless operator sets FORCE_ENRICH=true
    return String(process.env.FORCE_ENRICH || '').toLowerCase() === 'true';
  } catch (e) {
    return false;
  }
}

export default { allowEnrichment };
