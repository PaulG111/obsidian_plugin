import { Plugin, Notice } from 'obsidian';
import { simpleGit, SimpleGit } from 'simple-git';

export default class MyPlugin extends Plugin {
	git: SimpleGit;

	async onload() {
		const basePath = (this.app.vault.adapter as any).basePath;
		this.git = simpleGit(basePath);

		const style = document.createElement('style');
		style.id = 'hide-ribbon-icons';
		style.innerHTML = `
            .side-dock-ribbon-action:not([aria-label="récupérer"]):not([aria-label="Sauvegarder"]):not([aria-label="Settings"]) {
                display: none !important;
            }
        `;
		document.head.appendChild(style);

		const assetFolder = "image";

		if (!(await this.app.vault.adapter.exists(assetFolder))) {
			await this.app.vault.createFolder(assetFolder);
		}

		(this.app.vault as any).setConfig("attachmentFolderPath", assetFolder);

		this.addRibbonIcon('install', 'récupérer', async () => {
			try {
				new Notice("synchronisation en cours...");
				await this.git.pull('origin', 'master');
				new Notice("documentation mise à jour");
			} catch (error) {
				console.error(error);
				new Notice("Erreur lors de la mise à jour");
			}
		});

		this.addRibbonIcon('save', 'Sauvegarder', async () => {
			try {
				await this.git.add("./*");
				await this.git.commit("test sandbox", { "--amend": null, "--no-edit": null });
				await this.git.push('origin', 'HEAD:refs/for/master', { '--force': null });
				new Notice("documentation sauvegardée");
			} catch (error) {
				console.error(error);
				new Notice("Erreur lors de la sauvegarde Git");
			}
		});
	}
}
