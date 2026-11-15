import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

export class MemoryBank {
	constructor() {
		this.memory = {};
		this.file = null;
	}

	/**
	 * Village places survive a restart. Survival leaves this unbound and
	 * keeps the in-process bank it already had.
	 */
	bindPlaceFile(file, defaults = {}) {
		this.file = file;
		if (existsSync(file)) {
			try {
				const saved = JSON.parse(readFileSync(file, 'utf8'));
				if (saved && typeof saved === 'object') this.memory = saved;
			} catch {
				this.memory = {};
			}
		}
		for (const [name, coords] of Object.entries(defaults)) {
			if (!this.memory[name] && Array.isArray(coords)) this.memory[name] = coords;
		}
		this._save();
	}

	rememberPlace(name, x, y, z) {
		this.memory[name] = [x, y, z];
		this._save();
	}

	_save() {
		if (!this.file) return;
		mkdirSync(path.dirname(this.file), { recursive: true });
		writeFileSync(this.file, JSON.stringify(this.memory, null, 2));
	}

	recallPlace(name) {
		return this.memory[name];
	}

	getJson() {
		return this.memory
	}

	loadJson(json) {
		this.memory = json;
	}

	getKeys() {
		return Object.keys(this.memory).join(', ')
	}
}