import { execFileSync } from 'node:child_process';

// The development runner and package smoke use the built distribution. Build
// once before workers start so concurrent tests never replace grammar files.
export default function setup(): void {
  execFileSync('pnpm', ['build'], { cwd: process.cwd(), stdio: 'pipe' });
}
