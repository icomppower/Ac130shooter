import {defineConfig} from 'vite';
// GitHub Pages serves this repo from a subpath. Without `base` the built
// asset URLs resolve to the domain root and every request 404s.
export default defineConfig({base: '/Ac130shooter/', build: {target: 'es2022'}});
