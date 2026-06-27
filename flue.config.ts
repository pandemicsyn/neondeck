import { defineConfig } from '@flue/cli/config';
import { defineConfig as defineViteConfig } from 'vite';

export default defineConfig({
	target: 'node',
});

export const vite = defineViteConfig({
	server: {
		watch: {
			ignored: ['**/data/**', '**/web/dist/**'],
		},
	},
});
