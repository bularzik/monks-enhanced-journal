import { log, setting, i18n, MonksEnhancedJournal } from '../monks-enhanced-journal.js';
import { EnhancedJournalSheet } from "../sheets/EnhancedJournalSheet.js";
import { APSJ } from "../apsjournal.js";

export class ProseMirrorPlugin {
	static getProseMirrorMenuDropDowns(menu, items) {
		if (menu.view.dom.closest('.monks-journal-sheet,.journal-sheet.journal-entry-page')) {
			//APSJ.getProseMirrorMenuDropDowns.call(menu, items);

			let font_sizes = [8, 10, 12, 14, 18, 24, 36, 48];

			items.fontsize = {
				cssClass: 'mej-menu-fontsize',
				title: "Font Size",
				entries: font_sizes.map((fontsize) => {
					let size = `${fontsize}px`;
					return {
						action: `size${fontsize}`,
						title: `${fontsize}px`,
						style: `font-size: ${fontsize}px;line-height: ${Math.max(24, fontsize)}px`,
						mark: menu.schema.marks.size,
						attrs: { size },
						cmd: ProseMirror.commands.toggleMark(menu.schema.marks.size, { size })
					}
				}),
			};

			if (items?.format) {
				items.format.entries.push({
					action: "enhanced-journal",
					title: "Enhanced Journal",
					children: [
						{
							action: "read-aloud",
							title: "Read Aloud",
							attrs: { class: "readaloud" },
							node: menu.schema.nodes.paragraph,
							cmd: ProseMirrorPlugin._wrapReadAloud.bind(menu)
						},
						{
							action: "dropcap",
							title: "Drop Cap",
							style: `line-height: 3em`,
							mark: menu.schema.marks.span,
							attrs: { class: "drop-cap" },
							cmd: ProseMirror.commands.toggleMark(menu.schema.marks.span, {
								_preserve: {
									class: "drop-cap"
								}
							})
						}
					]
				});
			}

		}
	}

	static getProseMirrorMenuItems(menu, items) {
		if (menu.view.dom.closest('.monks-journal-sheet,.journal-sheet.journal-entry-page')) {
			const scopes = menu.constructor._MENU_ITEM_SCOPES;

			items.splice(5, 0, {
				action: "background-colour",
				title: "Change Background",
				icon: '<i class="fa-solid fa-brush fa-fw"></i>',
				scope: scopes.BOTH,
				priority: 10,
				cssClass: "mej-change-background",
				cmd: ProseMirrorPlugin._changeBackgroundPrompt.bind(menu)
			});

			items.splice(8, 0, {
				action: "apsj-template",
				title: "Insert Stylish Template",
				icon: '<i class="fa-solid fa-envelopes-bulk fa-fw"></i>',
				scope: scopes.BOTH,
				cssClass: "mej-apsj-template",
				cmd: ProseMirrorPlugin._insertAPSJPrompt.bind(menu)
			});
		}
	}

	static async _insertAPSJPrompt() {
		let data = {
			templateOptions: {
				...APSJ.blockList.reduce((obj, c) => {
					obj[`block_${c}`] = i18n(`APSJournal.block-${c}.name`);
					return obj;
				}, {}),
				...APSJ.dialogList.reduce((obj, c) => {
					obj[`dialogue_${c}_left`] = i18n(`APSJournal.block-dialogue-${c}-left.name`);
					obj[`dialogue_${c}_right`] = i18n(`APSJournal.block-dialogue-${c}-right.name`);
					return obj;
				}, {}),
				...APSJ.panelList.reduce((obj, c) => {
					obj[`panel_${c}`] = i18n(`APSJournal.panel-${c}.name`);
					return obj;
				}, {})
			}
		};
		const dialog = await this._showDialog("apsj-template", "modules/monks-enhanced-journal/templates/prosemirror/apsj-template.html", { data });
		const form = dialog.querySelector("form");

		// Center the form in the middle of the screen
        form.classList.add("mej-centered-form");
		Object.assign(form.style, { top: `${(window.innerHeight / 2) - (form.offsetHeight / 2) }px`, left: `${(window.innerWidth / 2) - (form.offsetWidth / 2)}px` });

		form.elements.template.addEventListener("change", async () => {
			const templateId = form.elements.template.value;
			const idParts = templateId.split("_");

			let element = "";
			switch (idParts[0]) {
				case "block":
					element = await APSJ.getBlock(idParts[1]);
					break;
				case "dialogue":
					element = await APSJ.getDialog(idParts[1], idParts[2]);
					break;
				case "panel":
					element = await APSJ.getPanel(idParts[1]);
					break;
			}
			$(".apsj-preview", dialog).html(element);
		});
		let changeEvent = new Event('change');
        form.elements.template.dispatchEvent(changeEvent);
		form.elements.insert.addEventListener("click", async () => {
			const templateId = form.elements.template.value;
			const idParts = templateId.split("_");

			let element = "";
			switch (idParts[0]) {
				case "block":
					element = await APSJ.getBlock(idParts[1]);
					break;
				case "dialogue":
					element = await APSJ.getDialog(idParts[1], idParts[2]);
					break;
				case "panel":
					element = await APSJ.getPanel(idParts[1]);
					break;
			}

            APSJ.addElement.call(this, element);
			dialog.remove();
		});
		form.elements.cancel.addEventListener("click", () => {
			dialog.remove();
		});
	}

	static async _changeBackgroundPrompt() {
		const documentUuid = $(this.view.dom).closest("div[entity-uuid]").attr("entity-uuid");
		const document = documentUuid ? await fromUuid(documentUuid) : null;

		if (document == null)
			return;

		const documentData = document.getFlag('monks-enhanced-journal', 'style') || {};
		const data = {
			img: documentData.img?.value || documentData.img || "",
			color: documentData.color || "transparent",
			sizing: documentData.sizing || "repeat",
			sizingOptions: {
				repeat: "Repeat",
				cover: "Cover",
				contain: "Contain",
				stretch: "Stretch"
			}
		};

		const dialog = await this._showDialog("background-colour", "modules/monks-enhanced-journal/templates/prosemirror/background-colour.html", { data });
		const form = dialog.querySelector("form");
		form.elements.update.addEventListener("click", () => {
			let updateStyle = {
				img: form.elements.img.value || "",
				color: form.elements.color.value || "transparent",
				sizing: form.elements.sizing.value || "repeat"
			};
			document.setFlag('monks-enhanced-journal', 'style', updateStyle);
			EnhancedJournalSheet.updateStyle(updateStyle, $(this.view.dom.closest(".editor-parent")));
			dialog.remove();
		});
		form.elements.cancel.addEventListener("click", () => {
			dialog.remove();
		});
	}

	static async _wrapReadAloud() {
		const state = this.view.state;
		let { $from, $to, $cursor } = state.selection;

		const range = $from.blockRange($to);
		if (range) {
			$from = range.start;
			$to = range.end;
		}
		const slice = state.doc.slice($from, $to);
		const section = this.schema.nodes.section.create({
			_preserve: {
				class: "readaloud"
			}
		}, slice.content);
		const tr = state.tr.replaceWith($from, $to, section);
		this.view.dispatch(tr);
	}
}

Hooks.on("getProseMirrorMenuDropDowns", ProseMirrorPlugin.getProseMirrorMenuDropDowns);
Hooks.on("getProseMirrorMenuItems", ProseMirrorPlugin.getProseMirrorMenuItems);