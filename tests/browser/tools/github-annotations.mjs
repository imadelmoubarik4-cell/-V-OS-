// Test reporter for `npm run test:browser`: under GitHub Actions each failed
// test also prints an error annotation (file, line, the first lines of the
// error), so a failure can be read from the check run without the full log.
// Elsewhere it prints nothing; the spec reporter stays the readable output.
import path from 'node:path';

const escapeData = (value) => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (value) => escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');

export default async function* githubAnnotations(source) {
  const enabled = Boolean(process.env.GITHUB_ACTIONS);
  for await (const event of source) {
    if (!enabled || event.type !== 'test:fail' || event.data.nesting !== 0) continue;
    const { name, file, line, details } = event.data;
    const error = details?.error?.cause || details?.error;
    const message = String(error?.message || error || 'failed').split('\n').slice(0, 8).join('\n');
    const where = file ? `file=${escapeProperty(path.relative(process.cwd(), file.replace(/^file:\/\//, '')))},line=${line || 1},` : '';
    yield `::error ${where}title=${escapeProperty(name)}::${escapeData(message)}\n`;
  }
}
