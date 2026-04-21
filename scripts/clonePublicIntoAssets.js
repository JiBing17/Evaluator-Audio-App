const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');

function copyDirectoryRecursive(source, destination) {
	fs.mkdirSync(destination, { recursive: true });

	for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
		const sourcePath = path.join(source, entry.name);
		const destinationPath = path.join(destination, entry.name);

		if (entry.isDirectory()) {
			copyDirectoryRecursive(sourcePath, destinationPath);
			continue;
		}

		if (entry.isFile()) {
			fs.copyFileSync(sourcePath, destinationPath);
		}
	}
}

function clonePublicFoldersIntoAssets() {
	fs.mkdirSync(ASSETS_DIR, { recursive: true });

	const publicEntries = fs.readdirSync(PUBLIC_DIR, { withFileTypes: true });
	const publicFolders = publicEntries.filter((entry) => entry.isDirectory());

	for (const folder of publicFolders) {
		const sourcePath = path.join(PUBLIC_DIR, folder.name);
		const destinationPath = path.join(ASSETS_DIR, folder.name);
		copyDirectoryRecursive(sourcePath, destinationPath);
		console.log(`Cloned folder: ${folder.name}`);
	}

	console.log(`Cloned ${publicFolders.length} folders`);
}

clonePublicFoldersIntoAssets();
