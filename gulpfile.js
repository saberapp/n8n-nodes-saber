const path = require('path');
const { task, src, dest } = require('gulp');

task('build:icons', copyIcons);

function copyIcons() {
	// Icons (svg/png) and node codex files (*.node.json) must sit next to the
	// compiled .js in dist for n8n to load them.
	const nodeSource = path.resolve('nodes', '**', '*.{png,svg,json}');
	const nodeDestination = path.resolve('dist', 'nodes');
	src(nodeSource).pipe(dest(nodeDestination));

	const credSource = path.resolve('credentials', '**', '*.{png,svg}');
	const credDestination = path.resolve('dist', 'credentials');
	return src(credSource).pipe(dest(credDestination));
}
