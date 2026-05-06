import {Plugin, Notice, Modal, App, PluginSettingTab, Setting } from 'obsidian';
import { simpleGit, SimpleGit } from 'simple-git';


interface MyPluginSettings {
	gerritUrl: string;
	username: string;
	password: string;
}
const DEFAULT_SETTINGS: MyPluginSettings = {
	gerritUrl: '',
	username: '',
	password: ''
}
export default class MyPlugin extends Plugin {
	git: SimpleGit;
	currentBranch: string = '';
	statusBarItem: HTMLElement;
	settings: MyPluginSettings;

	async onload() {
		try {
			await simpleGit().version();
		} catch (error) {
			new Notice("Git not found. Please install Git to use this plugin")
		}
		const basePath = (this.app.vault.adapter as any).basePath;
		await this.loadSettings();
		this.git = simpleGit(basePath);
		const hookPath = `${basePath}/.git/hooks/commit-msg`;
		const hookExists = await this.app.vault.adapter.exists('.git/hooks/commit-msg');
		if (!hookExists) {
			try {
				const hookUrl = `https://${this.settings.gerritUrl.split('/')[0]}/tools/hooks/commit-msg`;
				const response = await fetch(hookUrl);
				const hookContent = await response.text();
				require('fs').writeFileSync(hookPath, hookContent, { mode: 0o755});
				new Notice("Gerrit hook has been installed");
			} catch (error) {
				new Notice("Gerrit hook installation failed");
			}
		}
		const remoteUrl = `https://${this.settings.username}:${this.settings.password}@${this.settings.gerritUrl}`;
		await this.git.remote(['set-url', 'origin', remoteUrl]);

		const assetFolder = "image";
		if (!(await this.app.vault.adapter.exists(assetFolder))) {
			await this.app.vault.createFolder(assetFolder);
		}
		(this.app.vault as any).setConfig("attachmentFolderPath", assetFolder);

		this.statusBarItem = this.addStatusBarItem();
		await this.refreshBranchDisplay();

		this.addRibbonIcon('install', 'Update', async () => {
			try {
				new Notice("Syncing...");
				await this.git.pull('origin', this.currentBranch);
				new Notice("Documentation has been updated");
				await this.refreshBranchDisplay();
			} catch (error) {
				const msg = (error as Error).message ?? '';
				if (msg.includes('conflict')) {
					new Notice("Conflict detected");
				} else if (msg.includes('Authentication')) {
					new Notice("Git authentication failed");
				} else {
					new Notice("Update failed : " + msg.slice(0, 80));
				}
			}
		});

		this.addRibbonIcon('save', 'Save', async () => {

				const status = await this.git.status();
				if (status.files.length === 0) {
					new Notice("No changes to save");
					return;
				}

				new CommitModal(this.app, async (message) => {
					try {
						await this.git.add("./*");
						await this.git.commit(message);
						await this.git.push('origin', `HEAD:refs/for/master`);
						new Notice("Documentation has been saved");
					} catch (error) {
						const msg = (error as Error).message ?? '';
						if (msg.includes('Change-Id')) {
							new Notice("Missing Gerrit commit-msg hook");
						} else if (msg.includes('prohibited')) {
							new Notice("Gerrit: Push rejected. Check branch permissions");
						} else {
							new Notice("Save error : " + msg.slice(0, 80));
						}
					}
				}).open();
		});

		this.addRibbonIcon('git-branch', 'Switch version', async () => {
			try {
				await this.git.fetch();
				const branchSummary = await this.git.branch(['-r']);
				const branches = branchSummary.all
					.map(b => b.replace('origin/', '').trim())
					.filter(b => !b.includes('HEAD') && !b.includes('->'))
					.filter((b, i, arr) => arr.indexOf(b) === i);



				new VersionModal(this.app, branches, this.currentBranch, async (selectedBranch) => {
					new Notice(`Switching to ${selectedBranch}...`);
					try {
						const status = await this.git.status();
						const relevantFiles = status.files.filter(f => !f.path.startsWith('.obsidian/'));
						if (relevantFiles.length > 0) {
							new Notice("Save your changes before switching versions");
							return;
						}

						await this.git.checkout(selectedBranch);
						this.currentBranch = selectedBranch;
						this.statusBarItem.setText(`⎇ ${selectedBranch}`);
						await new Promise(resolve => setTimeout(resolve, 300));
						new Notice(`Version ${selectedBranch} active`);
					} catch (err) {
						const msg = (err as Error).message ?? '';
						if (msg.includes('modified')) {
							new Notice("Save your changes first");
						} else {
							new Notice("Checkout error : " + msg.slice(0, 80));
						}
					}
				}).open();
			} catch (error) {
				new Notice("Unable to fetch Git branches");
			}
		});
		this.addSettingTab(new MyPluginSettingTab(this.app, this));

		this.addRibbonIcon('file-plus', 'New page', () => {
			new NewPageModal(this.app, async (lang, module, name) => {
				const filePath = `${module}/${name}.${lang}.md`;
				if (await this.app.vault.adapter.exists(filePath)) { new Notice("File already exists"); return; }
				if(!(await this.app.vault.adapter.exists(module))) await this.app.vault.createFolder(module);
				await this.app.vault.create(filePath, `---\nlang: ${lang}\nmodule: ${module}\nversion: ${this.currentBranch}\n---\n\n`);
				const file = this.app.vault.getAbstractFileByPath(filePath);
				if (file) await (this.app as any).workspace.getLeaf().openFile(file);
				new Notice(`New page created : ${filePath}`);
			}).open();
		});
	}

	async refreshBranchDisplay() {
		try {
			const summary = await this.git.branchLocal();
			this.currentBranch = summary.current;
			this.statusBarItem.setText(`⎇ ${this.currentBranch}`);
		} catch {
			this.statusBarItem.setText('⎇ ?');
		}
	}
	async loadSettings(){
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class CommitModal extends Modal {
	onConfirm: (message: string) => void;

	constructor(app: App, onConfirm: (message: string) => void) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Save message" });

		const input = contentEl.createEl("input", { type: "text" });
		input.style.cssText = "width:100%;margin:12px 0;padding:6px;font-size:14px;";
		input.placeholder = "Describe your changes...";
		input.focus();

		const btn = contentEl.createEl("button", { text: "Save" });
		btn.style.cssText = "width:100%;padding:8px;cursor:pointer;margin-top:4px;";
		btn.onclick = () => {
			const message = input.value.trim();
			if (!message) {
				new Notice("Message can't be empty");
				return;
			}
			this.onConfirm(message);
			this.close();
		};

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") btn.click();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
class VersionModal extends Modal {
	branches: string[];
	currentBranch: string;
	onSelect: (branch: string) => void;

	constructor(app: App, branches: string[], currentBranch: string, onSelect: (branch: string) => void) {
		super(app);
		this.branches = branches;
		this.currentBranch = currentBranch;
		this.onSelect = onSelect;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Select a version" });
		contentEl.createEl("p", {
			text: `Active version : ${this.currentBranch}`,
			cls: "setting-item-description"
		});

		const container = contentEl.createDiv();
		container.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;";

		this.branches.forEach((branch) => {
			const btn = container.createEl("button", { text: branch });
			btn.style.cursor = "pointer";
			if (branch === this.currentBranch) {
				btn.style.fontWeight = "600";
				btn.style.outline = "2px solid var(--interactive-accent)";
			}
			btn.onclick = () => {
				this.onSelect(branch);
				this.close();
			};
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
class MyPluginSettingTab extends PluginSettingTab {
	plugin: MyPlugin;
	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('gerrit URL')
			.addText(text => text
				.setValue(this.plugin.settings.gerritUrl)
				.onChange(async (value)=> {
					this.plugin.settings.gerritUrl = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('username')
			.addText(text => text
				.setValue(this.plugin.settings.username)
				.onChange(async (value)=> {
					this.plugin.settings.username = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('password')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setValue(this.plugin.settings.password);
				text.onChange(async (value: string) => {
					this.plugin.settings.password = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.addButton(btn => btn
				.setButtonText('login')
				.onClick(async () => {
					const remoteUrl = `https://${this.plugin.settings.username}:${this.plugin.settings.password}@${this.plugin.settings.gerritUrl}`;
					const isGitRepo = await this.plugin.app.vault.adapter.exists('.git');
					if (!isGitRepo) {
						new Notice("Cloning repository...")
						try {
							const basePath = (this.plugin.app.vault.adapter as any).basePath
							await simpleGit().clone(remoteUrl, basePath)
							new Notice ("Repository cloned");
						} catch (error) {
							const msg = (error as Error).message ?? '';
							new Notice("Cloning failed : " + msg.slice(0,80));
						}

					} else {
						await (this.plugin as any).git.remote(['set-url', 'origin', remoteUrl]);
						new Notice ("Login settings saved")
					}
				}));
	}

}
class NewPageModal extends Modal {
	onConfirm: (lang: string, module: string, name: string) => void;

	constructor(app: App, onConfirm: (lang: string, module: string, name: string) => void) {
		super(app);
		this.onConfirm = onConfirm;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", {text: "New page"});

		const langInput = contentEl.createEl("input", { type: "text" });
		langInput.style.cssText = "display:block;width:100%;margin-bottom:12px;padding:6px;font-size:14px;";
		langInput.placeholder = "Language (ex: fr, en, es...)";
		langInput.maxLength = 2;

		const moduleInput = contentEl.createEl("input", { type: "text" });
		moduleInput.style.cssText = "display:block;width:100%;margin-bottom:12px;padding:6px;font-size:14px;";
		moduleInput.placeholder = "Section (ex: optical-patient-file)";

		const nameInput = contentEl.createEl("input", { type: "text" });
		nameInput.style.cssText = "display:block;width:100%;margin-bottom:12px;padding:6px;font-size:14px;";
		nameInput.placeholder = "Page name (ex: introduction)";

		const preview = contentEl.createEl("p")
		const updatePreview = () => preview.setText(`path : ${moduleInput.value.trim() || "module"}/${nameInput.value.trim() || "page"}.${langInput.value.toLowerCase().trim() || "lang"}.md`);
		updatePreview();

		langInput.oninput = moduleInput.oninput = nameInput.oninput = updatePreview;

		const btn = contentEl.createEl("button", { text: "Add"});
		btn.style.cssText= "display:block;width:100%;padding:8px;cursor:pointer;margin-top:8px;";
		btn.onclick = () => {
			if (!moduleInput.value.trim()) { new Notice("Untitled section"); return; }
			if(!nameInput.value.trim()) { new Notice("Untitled page"); return; }
			if (!langInput.value.trim() || langInput.value.trim().length !== 2) {
				new Notice("ISO Language Code (2 characters");
				return;
			}
			this.onConfirm(langInput.value.toLowerCase().trim(), moduleInput.value.trim(), nameInput.value.trim());
			this.close();
		};
		moduleInput.focus();
	}
	onClose() { this.contentEl.empty(); }
}