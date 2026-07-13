/**
 * prompt-lab/slots-conflicts.js - prompt-lab.js decomposition (verbatim Object.assign mixin).
 * Moved BYTE-IDENTICAL from frontend/js/prompt-lab.js pre-cut lines 848-943 (of 2,485):
 * toggleTagInSlot/removeTagFromSlot and the exclusion-rule conflict detection
 * (checkConflicts/getAllConflicts).
 * Classic script: joins the ONE unsealed window.PromptLab object declared
 * in prompt-lab/base.js (loads FIRST); prompt-lab/boot.js declares the
 * initPromptLab boot LAST; index.html lists the family in original line order.
 */
Object.assign(window.PromptLab, {
    // ============== Slot Management ==============

    toggleTagInSlot(category, tag) {
        if (!this.slots[category]) {
            this.slots[category] = [];
        }

        const idx = this.slots[category].indexOf(tag);
        if (idx >= 0) {
            this.slots[category] = this.slots[category].filter(t => t !== tag);
        } else {
            this.slots[category] = [...this.slots[category], tag];
        }

        this.invalidateGeneratedPrompt();
        this.renderCategoryBrowser();
        this.renderSlotBuilder();
    },

    removeTagFromSlot(category, tag) {
        if (this.slots[category]) {
            this.slots[category] = this.slots[category].filter(t => t !== tag);
        }
        this.invalidateGeneratedPrompt();
        this.renderCategoryBrowser();
        this.renderSlotBuilder();
    },

    // ============== Conflict Detection ==============

    checkConflicts(category) {
        const selected = this.slots[category] || [];
        if (selected.length === 0) return false;

        for (const rule of this.exclusionRules) {
            // Backend shape: { conditions: [{tag, type}], targets: [{tag, category}] }
            // checkConflicts only used for UI highlight — treat as best-effort
            const conditionMet = rule.conditions?.some((cond) => {
                const condTag = String(cond.tag || cond.pattern || '');
                // Check if any currently selected tag in any slot includes the condition tag
                return Object.values(this.slots).some(slotTags =>
                    slotTags.some(t => condTag && t.includes(condTag))
                );
            });

            if (conditionMet) {
                const hasExcluded = rule.targets?.some((target) => {
                    const targetCat = target.category || '';
                    const targetTag = String(target.tag || target.pattern || '');
                    if (!targetCat || targetCat === category) {
                        return selected.some(t => targetTag && t.includes(targetTag));
                    }
                    return false;
                }) || rule.excludes?.some((exc) => {
                    if (exc.category === category) {
                        return selected.some(t => exc.pattern && t.includes(exc.pattern));
                    }
                    return false;
                });
                if (hasExcluded) return true;
            }
        }
        return false;
    },

    getAllConflicts() {
        const conflicts = [];

        for (const rule of this.exclusionRules) {
            const conditionMet = rule.conditions?.some((cond) => {
                const condTag = String(cond.tag || cond.pattern || '');
                return condTag && Object.values(this.slots).some(slotTags =>
                    slotTags.some(t => t.includes(condTag))
                );
            });

            if (conditionMet) {
                const excludedTags = [];
                const targets = rule.targets || rule.excludes || [];
                for (const target of targets) {
                    const targetCat = target.category || '';
                    const targetTag = String(target.tag || target.pattern || '');
                    const catTags = targetCat ? (this.slots[targetCat] || []) : Object.values(this.slots).flat();
                    const found = targetTag ? catTags.filter(t => t.includes(targetTag)) : [];
                    excludedTags.push(...found.map(t => `${t}${targetCat ? ` (${targetCat})` : ''}`));
                }

                if (excludedTags.length > 0) {
                    conflicts.push(`"${rule.name}": ${excludedTags.join(', ')} should be excluded`);
                }
            }
        }

        return conflicts;
    },

});
