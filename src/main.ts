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
		const basePath = (this.app.vault.adapter as any).basePath;
		await this.loadSettings();
		this.git = simpleGit(basePath);
		const remoteUrl = `https://${this.settings.username}:${this.settings.password}@${this.settings.gerritUrl}`;
		await this.git.remote(['set-url', 'origin', remoteUrl]);

		const assetFolder = "image";
		if (!(await this.app.vault.adapter.exists(assetFolder))) {
			await this.app.vault.createFolder(assetFolder);
		}
		(this.app.vault as any).setConfig("attachmentFolderPath", assetFolder);

		this.statusBarItem = this.addStatusBarItem();
		await this.refreshBranchDisplay();

		this.addRibbonIcon('install', 'Récupérer', async () => {
			try {
				new Notice("Synchronisation en cours...");
				await this.git.pull('origin', this.currentBranch);
				new Notice("Documentation mise à jour");
				await this.refreshBranchDisplay();
			} catch (error) {
				const msg = (error as Error).message ?? '';
				if (msg.includes('conflict')) {
					new Notice("Conflit détecté");
				} else if (msg.includes('Authentication')) {
					new Notice("erreur d'authentification Git");
				} else {
					new Notice("Erreur lors de la mise à jour : " + msg.slice(0, 80));
				}
			}
		});

		this.addRibbonIcon('save', 'Sauvegarder', async () => {

				const status = await this.git.status();
				if (status.files.length === 0) {
					new Notice("Aucune modification à sauvegarder");
					return;
				}

				new CommitModal(this.app, async (message) => {
					try {
						await this.git.add("./*");
						await this.git.commit(message);
						await this.git.push('origin', `HEAD:refs/for/master`);
						new Notice("Documentation sauvegardée");
					} catch (error) {
						const msg = (error as Error).message ?? '';
						if (msg.includes('Change-Id')) {
							new Notice("Hook commit-msg Gerrit manquant");
						} else if (msg.includes('prohibited')) {
							new Notice("Push refusé par Gerrit, vérifiez vos droits sur cette branche");
						} else {
							new Notice("Erreur lors de la sauvegarde : " + msg.slice(0, 80));
						}
					}
				}).open();
		});

		this.addRibbonIcon('git-branch', 'Changer de version', async () => {
			try {
				const branchSummary = await this.git.branch(['-a']);
				const branches = branchSummary.all
					.map(b => b.replace('remotes/origin/', '').trim())
					.filter(b => !b.includes('HEAD') && !b.includes('->'))
					.filter((b, i, arr) => arr.indexOf(b) === i);

				new VersionModal(this.app, branches, this.currentBranch, async (selectedBranch) => {
					new Notice(`Changement vers ${selectedBranch}...`);
					try {
						const status = await this.git.status();
						const relevantFiles = status.files.filter(f => !f.path.startsWith('.obsidian/'));
						if (relevantFiles.length > 0) {
							new Notice("Sauvegardez vos modifications avant de changer de version");
							return;
						}

						await this.git.checkout(selectedBranch);
						this.currentBranch = selectedBranch;
						this.statusBarItem.setText(`⎇ ${selectedBranch}`);
						await new Promise(resolve => setTimeout(resolve, 300));
						new Notice(`Version ${selectedBranch} activée`);
					} catch (err) {
						const msg = (err as Error).message ?? '';
						if (msg.includes('modified')) {
							new Notice("Sauvegardez vos modifications d'abord");
						} else {
							new Notice("Erreur checkout : " + msg.slice(0, 80));
						}
					}
				}).open();
			} catch (error) {
				new Notice("Impossible de récupérer les branches Git");
			}
		});
		this.addSettingTab(new MyPluginSettingTab(this.app, this));
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
		contentEl.createEl("h2", { text: "Message de sauvegarde" });

		const input = contentEl.createEl("input", { type: "text" });
		input.style.cssText = "width:100%;margin:12px 0;padding:6px;font-size:14px;";
		input.placeholder = "Décrivez vos modifications...";
		input.focus();

		const btn = contentEl.createEl("button", { text: "Sauvegarder" });
		btn.style.cssText = "width:100%;padding:8px;cursor:pointer;margin-top:4px;";
		btn.onclick = () => {
			const message = input.value.trim();
			if (!message) {
				new Notice("Le message ne peut pas être vide");
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
		contentEl.createEl("h2", { text: "Choisir une version" });
		contentEl.createEl("p", {
			text: `Version active : ${this.currentBranch}`,
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
			.setName('URL gerrit')
			.addText(text => text
				.setValue(this.plugin.settings.gerritUrl)
				.onChange(async (value)=> {
					this.plugin.settings.gerritUrl = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('nom d\'utilisateur')
			.addText(text => text
				.setValue(this.plugin.settings.username)
				.onChange(async (value)=> {
					this.plugin.settings.username = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('mot de passe')
			.addText(text => text
				.setValue(this.plugin.settings.password)
				.onChange(async(value) => {
					this.plugin.settings.password = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.addButton(btn => btn
				.setButtonText('Connecter')
				.onClick(async () => {
					const remoteUrl = `https://${this.plugin.settings.username}:${this.plugin.settings.password}@${this.plugin.settings.gerritUrl}`;
					await (this.plugin as any).git.remote(['set-url', 'origin', remoteUrl])
					new Notice("connection configurée")
		}));
	}

}