import { execFileSync } from 'node:child_process';

const [workingDirectory, allowedRoot] = process.argv.slice(2);
if (!workingDirectory || !allowedRoot) {
  throw new Error('Usage: validateLaneDiffCli <workingDirectory> <allowedRoot>');
}

const output = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
  cwd: workingDirectory,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});

const entries = output.split('\0').filter(Boolean);
const paths: string[] = [];
for (const entry of entries) {
  const statusAndPath = entry.slice(3);
  const arrowIndex = statusAndPath.indexOf(' -> ');
  paths.push(arrowIndex >= 0 ? statusAndPath.slice(arrowIndex + 4) : statusAndPath);
}

const normalizedRoot = allowedRoot.replace(/^\.\//, '').replace(/\\/g, '/');
const denied = paths.filter((path) => {
  const normalized = path.replace(/^\.\//, '').replace(/\\/g, '/');
  return !normalized.startsWith(normalizedRoot);
});

if (denied.length > 0) {
  console.error('UNATTENDED_WRITE_SCOPE_VIOLATION');
  for (const path of denied) console.error(path);
  process.exit(2);
}

console.log(JSON.stringify({ changed_paths: paths, allowed_write_root: normalizedRoot }, null, 2));
