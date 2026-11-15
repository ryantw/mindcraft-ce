function ingredientId(ingredient) {
    if (ingredient == null) return null;
    return typeof ingredient === 'object' ? ingredient.id : ingredient;
}

function ingredientCount(ingredient) {
    if (ingredient == null || typeof ingredient !== 'object') return 1;
    return Math.abs(ingredient.count ?? 1);
}

function addIngredient(registry, ingredients, ingredient) {
    const id = ingredientId(ingredient);
    if (id == null || id < 0) return;
    const name = registry.items[id]?.name;
    if (!name) return;
    ingredients[name] = (ingredients[name] || 0) + ingredientCount(ingredient);
}

function recipeRequiresTable(recipe) {
    if (recipe.requiresTable != null) return recipe.requiresTable;
    if (recipe.inShape) {
        const height = recipe.inShape.length;
        const width = recipe.inShape.reduce((maximum, row) => Math.max(maximum, row?.length || 0), 0);
        return width > 2 || height > 2;
    }
    return (recipe.ingredients?.length || 0) > 4;
}

export function getCraftingRecipeVariants(registry, itemName) {
    const item = registry.itemsByName[itemName];
    if (!item) return [];
    const variants = [];
    const seen = new Set();
    for (const recipe of registry.recipes[item.id] || []) {
        const ingredients = {};
        if (recipe.inShape) {
            for (const row of recipe.inShape) {
                for (const ingredient of row || []) addIngredient(registry, ingredients, ingredient);
            }
        }
        if (recipe.ingredients) {
            for (const ingredient of recipe.ingredients) addIngredient(registry, ingredients, ingredient);
        }
        if (Object.keys(ingredients).length === 0) continue;
        const requiresTable = recipeRequiresTable(recipe);
        const signature = `${requiresTable}:${JSON.stringify(ingredients)}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        variants.push({
            ingredients,
            resultCount: recipe.result?.count || 1,
            requiresTable,
            recipe,
        });
    }
    return variants;
}

function effectiveInventoryCount(inventory, ingredientName) {
    let count = inventory[ingredientName] || 0;
    if (ingredientName.endsWith('_planks')) {
        const wood = ingredientName.slice(0, -'_planks'.length);
        count += (inventory[`${wood}_log`] || 0) * 4;
        count += (inventory[`${wood}_wood`] || 0) * 4;
    }
    return count;
}

function recipeScore(variant, inventory) {
    const commonIngredients = new Set(['oak_planks', 'oak_log', 'coal', 'cobblestone']);
    let missing = 0;
    let directMissing = 0;
    let matching = 0;
    let common = 0;
    for (const [name, required] of Object.entries(variant.ingredients)) {
        const direct = inventory[name] || 0;
        const effective = effectiveInventoryCount(inventory, name);
        directMissing += Math.max(0, required - direct);
        missing += Math.max(0, required - effective);
        matching += Math.min(required, effective);
        if (commonIngredients.has(name)) common += required;
    }
    return { missing, directMissing, matching, common };
}

export function selectCraftingRecipe(registry, itemName, inventory={}) {
    const variants = getCraftingRecipeVariants(registry, itemName);
    let selected = null;
    let selectedScore = null;
    for (const variant of variants) {
        const score = recipeScore(variant, inventory);
        if (!selected
            || score.missing < selectedScore.missing
            || (score.missing === selectedScore.missing && score.directMissing < selectedScore.directMissing)
            || (score.missing === selectedScore.missing && score.directMissing === selectedScore.directMissing && score.matching > selectedScore.matching)
            || (score.missing === selectedScore.missing && score.directMissing === selectedScore.directMissing && score.matching === selectedScore.matching && score.common > selectedScore.common)) {
            selected = variant;
            selectedScore = score;
        }
    }
    return { selected, variants };
}

export function formatIngredients(ingredients, multiplier=1) {
    return Object.entries(ingredients)
        .map(([name, count]) => `${count * multiplier} ${name}`)
        .join(' + ');
}

export function formatRecipeAlternatives(variants, selected, multiplier=1) {
    if (!selected || variants.length <= 1) return '';
    const common = Object.entries(selected.ingredients).filter(([name, count]) =>
        variants.every(variant => variant.ingredients[name] === count)
    );
    const variableParts = variants.map(variant =>
        Object.entries(variant.ingredients).filter(([name, count]) =>
            !common.some(([commonName, commonCount]) => commonName === name && commonCount === count)
        )
    );
    if (variableParts.every(parts => parts.length === 1)) {
        const counts = new Set(variableParts.map(parts => parts[0][1]));
        if (counts.size === 1) {
            const amount = variableParts[0][0][1] * multiplier;
            const names = variableParts.map(parts => parts[0][0]);
            return `Valid ingredient alternatives: ${amount} of one of ${names.join(', ')}.`;
        }
    }
    const alternatives = variants
        .filter(variant => variant !== selected)
        .map(variant => formatIngredients(variant.ingredients, multiplier));
    if (alternatives.length === 0) return '';
    return `Valid recipe alternatives: ${alternatives.join(' OR ')}.`;
}
