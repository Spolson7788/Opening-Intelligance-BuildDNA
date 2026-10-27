import {defineConfig} from 'vitest/config';
export default defineConfig({test:{environment:'jsdom',environmentOptions:{jsdom:{url:'https://oi-video-workflows-staging.netlify.app/dashboard/qr-read-acceptance'}},include:['tests/qrReadAcceptance.test.ts']}});
