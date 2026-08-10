import { MonksEnhancedJournal, log, setting, i18n } from '../monks-enhanced-journal.js';
import { MEJHelpers } from '../helpers.js';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api

export class AdjustPrice extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(options = {}) {
        super(options);
        this.document = options.document;
    }

    // AdjustPrice is only ever opened for a shop (per-document from ShopSheet, or world-wide
    // from the settings menu with no document at all - see DEFAULT_OPTIONS.actions below and
    // settings.js's 'adjustPrices' registerMenu entry), so the world-default row it reads/
    // writes always lives under the "shop" key of the sheet-settings world setting - the same
    // object EnhancedJournalSheet#sheetSettings()/MEJHelpers.adjustmentRate() read at runtime.
    get adjustmentType() {
        return this.document?.type ?? "shop";
    }

    static DEFAULT_OPTIONS = {
        id: "adjust-price",
        tag: "form",
        classes: ["adjust-price"],
        sheetConfig: false,
        window: {
            contentClasses: ["standard-form"],
            //icon: "fa-solid fa-align-justify",
            title: "MonksEnhancedJournal.AdjustPrices"
        },
        actions: {
            cancel: AdjustPrice.onClose,
            reset: AdjustPrice.resetValues,
            convert: AdjustPrice.convertItems,
            addTier: AdjustPrice.onAddTier,
            removeTier: AdjustPrice.onRemoveTier
        },
        position: { width: 400 },
        form: {
            handler: AdjustPrice.onSubmitForm,
            closeOnSubmit: true,
            submitOnClose: false,
            submitOnChange: false
        }
    };

    static PARTS = {
        form: {
            classes: ["standard-form"],
            template: "modules/monks-enhanced-journal/templates/adjust-price.html"
        },
        footer: {
            template: "templates/generic/form-footer.hbs"
        }
    };

    async _preparePartContext(partId, context, options) {
        context = await super._preparePartContext(partId, context, options);
        switch (partId) {
            case "form":
                this._prepareBodyContext(context, options);
                break;
            case "footer":
                context.buttons = this.prepareButtons();
        }

        return context;
    }

    _prepareBodyContext(context, options) {
        // Get list of Item types for this system
        const original = Object.keys(game.system?.documentTypes?.Item || {});
        let types = original.filter(x => MonksEnhancedJournal.includedTypes.includes(x));
        types = types.reduce((obj, t) => {
            const label = CONFIG.Item?.typeLabels?.[t] ?? t;
            obj[t] = { name: game.i18n.has(label) ? game.i18n.localize(label) : t };
            return obj;
        }, {});

        // Get the default adjustment settings, and set the current adjustment settings to default.
        // This must read the same world row the live buy/sell flow resolves against
        // (sheet-settings.<type>.adjustment - see EnhancedJournalSheet#sheetSettings()), not the
        // orphaned "adjustment-defaults" setting nothing else ever wrote to.
        let defaultAdjustment = foundry.utils.getProperty(setting("sheet-settings") || {}, `${this.adjustmentType}.adjustment`) || {};

        // unsaved edits collected across an addTier/removeTier/reset re-render take priority
        // over whatever's stored, so they survive the re-render (same pattern as priceTiers
        // below); undefined (never touched yet this session) falls back to the stored value.
        let adjustments = foundry.utils.duplicate(this._adjustment !== undefined
            ? this._adjustment
            : (this.document ? (this.document.getFlag('monks-enhanced-journal', 'adjustment') || {}) : (defaultAdjustment || {})));

        // the stored priceTiers key must not become a bogus type row below; prefer any
        // unsaved edits collected across an addTier/removeTier re-render
        let priceTiers = this._tiers ?? (adjustments.priceTiers || []);
        delete adjustments.priceTiers;

        for (let t of Object.keys(types)) {
            let adj = adjustments[t] || { sell: null, buy: null };
            let defValue = defaultAdjustment[t] || { sell: null, buy: null };
            adjustments[t] = { ...adj, default: defValue };
        }
        foundry.utils.setProperty(adjustments, "default.default", defaultAdjustment.default || { sell: 1, buy: 0.5 });
        foundry.utils.mergeObject(adjustments, types);

        adjustments = Object.keys(adjustments).map(k => {
            return { id: k, ...adjustments[k] };
        }).sort((a, b) => {
            if (a.id === "default") return -1;
            if (b.id === "default") return 1;
            return a.name.localeCompare(b.name);
        });

        return foundry.utils.mergeObject(context, {
            adjustments,
            priceTiers,
            showConvert: !!this.options.document
        });
    }

    prepareButtons() {
        let buttons = [
            {
                type: "submit",
                icon: "far fa-check",
                label: "Save",
            },
            {
                type: "button",
                icon: "fas fa-times",
                label: "Cancel",
                action: "cancel"
            },
        ];

        // Reset is useful whether or not there's a document - it clears the working state back
        // to blank either way (see resetValues below) - so it's no longer document-gated.
        buttons.unshift({
            type: "button",
            icon: "fas fa-undo",
            label: "Reset",
            action: "reset"
        });

        return buttons;
    }

    async _onRender(context, options) {
        super._onRender(context, options);

        $('.sell-field', this.element).on("blur", this.validateField.bind(this));
    }

    static resetValues(event) {
        event.stopPropagation();
        event.preventDefault();

        // Clear both the type-row overrides and the price-tier rows, then re-render so the
        // (now blank) working state - not the stale document/world values - is what's shown.
        // A plain jQuery blank of the sell/buy inputs can't reach the tier rows (a dynamic,
        // keyed list), so this has to go through the same working-state + render path
        // addTier/removeTier use.
        this._adjustment = {};
        this._tiers = [];
        this.render();
    }

    validateField(event) {
        let val = parseFloat($(event.currentTarget).val());
        if (!isNaN(val) && val < 0) {
            $(event.currentTarget).val('');
        }
    }

    static onAddTier(event, target) {
        this._adjustment = this._collectAdjustment();
        this._tiers = this._collectTiers();
        this._tiers.push({ threshold: null, sell: null, buy: null });
        this.render();
    }

    static onRemoveTier(event, target) {
        let idx = parseInt(target.closest("[data-tier-idx]").dataset.tierIdx);
        this._adjustment = this._collectAdjustment();
        this._tiers = this._collectTiers();
        this._tiers.splice(idx, 1);
        this.render();
    }

    _collectTiers() {
        // read live form inputs so unsaved edits survive add/remove re-renders
        return Array.from(this.element.querySelectorAll("[data-tier-idx]")).map(row => ({
            threshold: row.querySelector("[name$='.threshold']")?.valueAsNumber ?? null,
            sell: row.querySelector("[name$='.sell']")?.valueAsNumber ?? null,
            buy: row.querySelector("[name$='.buy']")?.valueAsNumber ?? null,
        })).map(t => ({
            threshold: Number.isNaN(t.threshold) ? null : t.threshold,
            sell: Number.isNaN(t.sell) ? null : t.sell,
            buy: Number.isNaN(t.buy) ? null : t.buy,
        }));
    }

    // read live form inputs so unsaved type-row edits survive add/remove/reset re-renders,
    // using the exact same "what counts as set" cleanup onSubmitForm applies (_cleanAdjustment)
    _collectAdjustment() {
        const fd = new foundry.applications.ux.FormDataExtended(this.element);
        let data = foundry.utils.expandObject(fd.object);
        return AdjustPrice._cleanAdjustment(data.adjustment);
    }

    // Strips blank sell/buy entries and now-empty type entries. Shared by onSubmitForm (final
    // persist) and _collectAdjustment (the add/remove/reset re-render buffer) so both treat
    // blank fields identically.
    static _cleanAdjustment(adjustment) {
        adjustment = foundry.utils.duplicate(adjustment || {});
        for (let [k, v] of Object.entries(adjustment)) {
            if (v.sell == undefined)
                delete v.sell;
            if (v.buy == undefined)
                delete v.buy;

            if (Object.keys(v).length == 0)
                delete adjustment[k];
        }
        return adjustment;
    }

    // priceTiers live as a sibling of `adjustment` in the expanded form data (not nested
    // under it); returns the sorted/filtered array ready to attach at `adjustment.priceTiers`
    static _extractTiers(expandedData) {
        return Object.values(expandedData.priceTiers || {})
            .filter(t => t.threshold != undefined && t.threshold !== null && t.threshold !== "")
            .sort((a, b) => a.threshold - b.threshold);
    }

    static async onSubmitForm(event, form, formData) {
        let submitData = foundry.utils.expandObject(formData.object);
        submitData.adjustment = AdjustPrice._cleanAdjustment(submitData.adjustment);

        foundry.utils.setProperty(submitData.adjustment, "priceTiers", AdjustPrice._extractTiers(submitData));

        if (this.options.document) {
            await this.options.document.unsetFlag('monks-enhanced-journal', 'adjustment');
            await this.options.document.setFlag('monks-enhanced-journal', 'adjustment', submitData.adjustment);
            // Bridge to the flag namespace the live buy/sell call sites actually read
            // (ShopSheet#sheetSettings() -> flags.monks-enhanced-journal.sheet-settings.adjustment).
            // ShopSheet.js's one-time migration only copies flags.adjustment -> sheet-settings.adjustment
            // the first time a shop is rendered and never resyncs after that, so without this the
            // dialog's edits (including these price tiers) would silently never reach the live
            // player-sell/buy-back flow for any shop that already went through that migration.
            await this.options.document.unsetFlag('monks-enhanced-journal', 'sheet-settings.adjustment');
            await this.options.document.setFlag('monks-enhanced-journal', 'sheet-settings.adjustment', submitData.adjustment);
        } else {
            // No document: this is the world-defaults dialog (settings.js's 'adjustPrices'
            // menu), so merge into the sheet-settings world setting at <type>.adjustment - the
            // same place EnhancedJournalSheet#sheetSettings()/MEJHelpers.adjustmentRate() read.
            let sheetSettings = foundry.utils.duplicate(setting("sheet-settings") || {});
            foundry.utils.setProperty(sheetSettings, `${this.adjustmentType}.adjustment`, submitData.adjustment);
            await game.settings.set("monks-enhanced-journal", "sheet-settings", sheetSettings, { diff: false });
        }
    }

    static async convertItems(event, target) {
        const fd = new foundry.applications.ux.FormDataExtended(this.element);
        let data = foundry.utils.expandObject(fd.object);

        foundry.utils.setProperty(data.adjustment, "priceTiers", AdjustPrice._extractTiers(data));

        this.options.journalsheet.convertItems(data);

        /*
        for (let [k, v] of Object.entries(data.adjustment)) {
            if (v.sell == undefined)
                delete data.adjustment[k].sell;
            if (v.buy == undefined)
                delete data.adjustment[k].buy;

            if (Object.keys(data.adjustment[k]).length == 0)
                delete data.adjustment[k];
        }

        let adjustment = Object.assign({}, setting("adjustment-defaults"), data.adjustment || {});

        let items = this.options.document.getFlag('monks-enhanced-journal', 'items') || {};

        for (let item of Object.values(items)) {
            let sell = adjustment[item.type]?.sell ?? adjustment.default.sell ?? 1;
            let price = MEJHelpers.getPrice(foundry.utils.getProperty(item, "flags.monks-enhanced-journal.price"));
            let cost = Math.max(Math.ceil((price.value * sell), 1)) + " " + price.currency;
            foundry.utils.setProperty(item, "flags.monks-enhanced-journal.cost", cost);
        }

        await this.options.document.update({ "flags.monks-enhanced-journal.items": items }, { focus: false });
        */
    }

    static onClose(event, form) {
        this.close();
    }
}