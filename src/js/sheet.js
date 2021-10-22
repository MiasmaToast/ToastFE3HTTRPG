
/**
 * A module that implements the main controller for the sheet, as well as some
 * small models and utilities that are too small to separate into other modules
 * @module sheet
 */

/* global MacroBuilder */

/* global Ability */
/* global Class */
/* global CombatArt */
/* global Weapon */
/* global Equipment */

/* global CategoryModel */
/* global MultiActiveCategory */
/* global SingleActiveCategory */

const VERSION = "1.14.0";

/**
 * Create a compound iterator from a group of iterable values
 */
function* chain(...iterables) {
	for (let iterable of iterables) {
		for (let each of iterable) {
			yield each;
		}
	}
}

class LevelStamp {

	static NAMES = [
		"hp",
		"str",
		"mag",
		"dex",
		"spd",
		"def",
		"res",
		"cha",
	];

	static SHIFT = BigInt(32);

	static MASK  = BigInt(0xFFFFFFFF);

	constructor(level, increases, date) {
		this.level     = level;
		this.increases = increases;
		this.date      = date;
	}

	*words() {
		let word = 0;
		for (let i = 0; i < 8; ++i) {
			const name       = LevelStamp.NAMES[i];
			const increased  = this.increases.has(name);
			word            |= increased << i;
		}
		word |= this.level << 8;
		yield word;
		
		const integer = BigInt(this.date.getTime());

		yield Number(integer >> LevelStamp.SHIFT);
		yield Number(integer &  LevelStamp.MASK);
	}

	pack() {
		return LevelStamp.pack(this);
	}

	static read(block, start) {
		const level     = block[start] >> 8;
		const increases = new Set();
		for (let i = 0; i < 8; ++i) {
			if (block[start] & (1 << i)) {
				increases.add(LevelStamp.NAMES[i]);
			}
		}
		const timestamp = Number(
			(BigInt(block[start + 1])
				<< LevelStamp.SHIFT) | BigInt(block[start + 2])
		);
		return new LevelStamp(level, increases, new Date(timestamp));
	}

	static write(block, sub, stamp) {
		const iter     = stamp.words();
		block[sub]     = iter.next().value;
		block[sub + 1] = iter.next().value;
		block[sub + 2] = iter.next().value;
		return block;
	}

	static pack(data) {

		if (data instanceof LevelStamp) {
			return LevelStamp.write(new Uint32Array(3), 0, data);
		}
		
		const block = new Uint32Array(data.length * 3);
		for (let i = 0; i < data.length; ++i) {
			LevelStamp.write(block, i * 3, array[i]);
		}
		return block;
	}

	static unpack(block) {
		const array = [];
		for (let i = 0; i < block.length; i += 3) {
			array.push(LevelStamp.unpackTriple(block, i));
		}
		return array;
	}
}

/**
 * Class representing a skill grade
 */
class Grade {

	static list = [
		new Grade("E",  0), new Grade("E+",  1),
		new Grade("D",  2), new Grade("D+",  4),
		new Grade("C",  8), new Grade("C+", 12),
		new Grade("B", 18), new Grade("B+", 25),
		new Grade("A", 32), new Grade("A+", 40),
		new Grade("S", 50), new Grade("S+", 60), 
	];

	/**
	 * Converts a number of points to the corresponding letter grade
	 * @static
	 * @param {number} points - number of points
	 * @returns {string} the letter grade
	 */
	static for(points) {
		return Grade.list.reduce((a, b) => b.points > points ? a : b).name;
	}

	/**
	 * Create a grade
	 * @param {string} name - letter for the grade
	 * @param {number} points - minimum number of points to acheive the grade
	 */
	constructor(name, points) {
		this.name   = name;
		this.points = points;
	}
}

/**
 * Class representing the main body of the sheet.
 */
class Sheet {

	/**
	 * Initialize the sheet
	 * @param {Object} data - the json format game data
	 */
	constructor(data) {

		/** @todo MOVE THIS AFTER FIXING PFE COMPILER INIT */
		this.cache   = {stats: {}, growths: {}};
		this._highID = 0;
		this.charID  = 0;

		/** @todo MOVE THIS SOMEWHERE BETTER */
		// PFE_COMPILER = new PostfixCompiler(["current_hp", ...data.stats.names]);
		CACHE = this.cache.stats;

		// set the lookup tables for each feature class
		for (let each of [Ability, Weapon, CombatArt, Equipment, Class]) {
			each.setLookupByName(data);
		}

		// main definition data object
		this.data = data;

		/* define attributes for document elements */

		/* level */
		this._input_level       = document.getElementById("level-input");
		this._output_level      = document.getElementById("level");

		/* hitpoints */
		this._input_hitpoints   = document.getElementById("hitpoints-input");
		this._output_hitpoints  = document.getElementById("hitpoints");

		/* mounted */
		this._input_mounted     = document.getElementById("character-mounted");

		/* triangle */
		this._select_triangle   = document.getElementById("character-triangle");

		/* name */
		this._input_name        = document.getElementById("character-name");

		this._input_name.onchange = (() => {
			const charID = this.characters.getActive();
			if (charID === null) return;

			const element = this.characters.elements.get(charID);
			element.title = this._input_name.value;
		});

		/* description */
		this._input_description = document.getElementById("character-description");

		this._input_description.onchange = (() => {
			const charID = this.characters.getActive();
			if (charID === null) return;

			const element       = this.characters.elements.get(charID);
			element.description = this._input_description.value;
		});

		/* autogenerate properties for inputs with not special refresh effect */
		// this.makePropertyForInput("name", "character-name", String);
		this.makePropertyForInput("homeland", "character-homeland", String);
		// this.makePropertyForInput("description", "character-description", String);

		/* set default class name */
		this.class = "Commoner";

		/* set levelup tracking array */
		this.levelups = [];

		/* populate skills, stats, and growths */
		this.stats   = {};
		this.growths = {};
		for (let name of this.data.stats.names) {
			this.stats[name]   = 0;
			if (name == "mov") continue;
			this.growths[name] = 0;
		}

		this.skills  = {};
		for (let name of this.data.skills) {
			this.skills[name] = 0;
		}

		/* initialize event listener for upload */
		document
			.getElementById("import-sheet")
			.addEventListener("change", (e) => {this.import(e);}, false);

		/* create callbacks for category events */
		const refresh = (category, key) => {
			console.log("refresh", key);
			category.toggleActive(key);
			this.refreshAllStats();
		};

		const forget  = (category, key) => {
			console.log("forget", key);
			category.delete(key);
			this.refreshAllStats();
		};

		const equip   = (category, key) => {
			console.log("equip", key);
			const next = category.next;
			if (!category.next) return;

			if (category.isActive(key)) {
				/* active elements are automaticall toggled off when deleted */
				category.next.delete(key);
			} else {
				next.add(key);
			}

			category.toggleActive(key);
			this.refreshAllStats();
		};
		
		const unequip = (category, key) => {
			console.log("unequip", key);
			if (!category.prev) return;
			/* key WILL implicitly be present and active in .prev */
			console.assert(category.prev.has(key));
			category.prev.toggleActive(key);
			category.delete(key);
			this.refreshAllStats();
		};

		const myFeatureTitle = ((feature) => feature.title()); 
		const myFeatureBody  = ((feature) => feature.body());

		/* Ability category */

		const myAbilityModel = new CategoryModel(
			Ability.kind, Ability.byName, myFeatureTitle, myFeatureBody 
		);
		
		this.abilities = {};

		this.addCategory(new MultiActiveCategory(myAbilityModel, {
			name        : "class",
			selectable  : false,
			reorderable : false,
			removable   : false,
			ontoggle    : refresh,
			onremove    : null,
		}));

		this.addCategory(new MultiActiveCategory(myAbilityModel, {
			name        : "equipped",
			selectable  : false,
			reorderable : true,
			removable   : true,
			ontoggle    : refresh,
			onremove    : unequip,
		}));

		this.addCategory(new MultiActiveCategory(myAbilityModel, {
			name        : "battlefield",
			selectable  : true,
			reorderable : true,
			removable   : true,
			ontoggle    : refresh,
			onremove    : forget,
		}));

		this.addCategory(new MultiActiveCategory(myAbilityModel, {
			name        : "known",
			selectable  : true,
			reorderable : true,
			removable   : true,
			ontoggle    : equip,
			onremove    : forget,
		}));

		this.abilities.known.link(this.abilities.equipped);

		/* CombatArt category */

		const myCombatArtModel = new CategoryModel(
			CombatArt.kind, CombatArt.byName, myFeatureTitle, myFeatureBody
		);

		this.combatarts = {};

		this.addCategory(new SingleActiveCategory(myCombatArtModel, {
			name        : "equipped",
			selectable  : false,
			reorderable : true,
			removable   : true,
			ontoggle    : refresh,
			onremove    : unequip,
		}));


		this.addCategory(new MultiActiveCategory(myCombatArtModel, {
			name        : "known",
			selectable  : true,
			reorderable : true,
			removable   : true,
			ontoggle    : equip,
			onremove    : forget,
		}));

		this.combatarts.known.link(this.combatarts.equipped);

		/* Weapon category */

		const myWeaponModel = new CategoryModel(
			Weapon.kind, Weapon.byName, myFeatureTitle, myFeatureBody
		);

		this.weapons = {};

		this.addCategory(new SingleActiveCategory(myWeaponModel, {
			name        : "known",
			selectable  : true,
			reorderable : true,
			removable   : true,
			ontoggle    : refresh,
			onremove    : forget,
		}));

		/* Equipment category */

		const myEquipmentModel = new CategoryModel(
			Equipment.kind, Equipment.byName, myFeatureTitle, myFeatureBody
		);

		this.equipment = {};

		this.addCategory(new SingleActiveCategory(myEquipmentModel, {
			name        : "known",
			selectable  : true,
			reorderable : true,
			removable   : true,
			ontoggle    : refresh,
			onremove    : forget,
		}));


		this.myCharMap       = new Map();
		const characterModel = new CategoryModel(
			"characters", this.myCharMap, (x) => x.name, (x) => x.description 
		);

		this.characters = new SingleActiveCategory(characterModel, {
			name        : "list",
			selectable  : false,
			reorderable : true,
			removable   : true,
			ontoggle    : ((category, key) => void this.changeCharacter(key)),
			onremove    : ((category, key) => void this.removeCharacter(key)),
		});

		this.characters.addTo(document.getElementById("character-list"));

		this.fresh();
	}

	/* methods relating to adding definitions */

	// addDefinitions(definitions) {
		
	// }

	createID() {
		const value   = this._highID;
		this._highID += 1;
		return value;
	}

	changeCharacter(key) {
		this.myCharMap.set(this.charID, this.writeCharacter());
		this.charID = key;
		this.characters.toggleActive(key);
		/* this must go after the character is toggled */
		/* side effects on syncing the name field with the sidebar */ 
		this.readCharacter(this.myCharMap.get(key));
	}

	removeCharacter(key) {
		if (key == this.charID) {
			alert("You cannot delete the active character.");
			return;
		}

		this.characters.delete(key);
		this.myCharMap.delete(key);
	}

	/* methods relating to initialization */

	/**
	 * Add a {@link Category} to this sheet at sheet[feature][category]
	 * @param {Category} category - the category to add 
	 */
	addCategory(category) {
		const identifier = category.model.name + "-" + category.name;
		const parent     = document.getElementById(identifier);

		this[category.model.name][category.name] = category;
		category.addTo(parent);
	}

	/**
	 * Create a getter/setter pair to access the an input element as a property
	 * @param {string} name - the name of the property
	 * @param {string} id - the identifer of the input element
	 * @param {Function} type - the type to convert to return the getter output as
	 */
	makePropertyForInput(name, id, type) {
		Object.defineProperty(this, name, {
			get: function () {
				return type(document.getElementById(id).value);
			},
			set: function (value) {
				document.getElementById(id).value = value;
			}
		});
	}

	/**
	 * This character's name
	 * @type {string}
	 */
	get name() {
		return this._input_name.value;
	}

	set name(value) {
		this._input_name.value = value;

		const charID = this.characters.getActive();
		if (charID === null) return;

		const element = this.characters.elements.get(charID);
		element.title = value;
	}

	/**
	 * A description of the character
	 * @type {string}
	 */
	get description() {
		return this._input_description.value;
	}

	set description(value) {
		this._input_description.value = value;

		const charID = this.characters.getActive();
		if (charID === null) return;

		const element       = this.characters.elements.get(charID);
		element.description = value;
	}

	/**
	 * The number of experience points this character has
	 * @type {number}
	 */
	get level() {
		return Number(this._input_level.value);
	}

	set level(value) {
		this._input_level.value = value;
		this.refreshLevel();
	}

	/**
	 * Set the level displayed to be 1/100 of the number of experience points
	 */
	refreshLevel() {
		this._output_level.textContent = 1 + Math.floor(this.level / 100);
	}

	/**
	 * Increase the character's level by 1, with a probability for each stat to
	 * increase by 1 equal to the growth rate of that stat. If one or fewer stats
	 * increase, allow the user to choose one stat to increase by one instead.
	 */
	levelUp() {
		// statistics that increased from this level up
		const increases = new Set();
		const names     = this.data.stats.names.filter(
			name => name != "mov" // This ain't Jugdral, we don't do mov growth.
		);

		// for each stat, if roll succeeds increase statistic
		for (let name of names) {
			if (Math.random() * 100 <= this.cache.growths[name]) {
				increases.add(name);
			}
		}

		// if only of fewer statistics increased during level up,
		// then prompt user for stat to increase with popup
		if (increases.size <= 1) {

			let   choosen     = null;
			const prompt_text = (
				"Enter one of: " + names.join(" ")
			);

			while (!names.includes(choosen)) {

				choosen = prompt(prompt_text);

				if (choosen === null) {
					break;
				} else {
					choosen = choosen.toLowerCase();
				}
			}

			if (choosen !== null) {
				increases.clear();
				increases.add(choosen);
			}
		}

		// show user summary of levelup
		const myIncreaseString = Array.from(increases).join(" ");
		alert("Increases: " + myIncreaseString);

		// update and refresh the sheet
		for (let name of increases) {
			const input = document.getElementById(name + "-base");
			input.value = Number(input.value) + 1;
		}

		this.refreshAllStats();
		this.level = this.level + 100; // this.level stores exp points
		
		// store the levelup record for later
		const level= Math.floor(this.level / 100) + 1;
		this.levelups.push(new LevelStamp(level, increases, new Date()));
	}

	
	/**
	 * The number of hitpoints this character has; not the hitpoint total
	 * @type {number}
	 */
	get hitpoints() {
		return Number(this._input_hitpoints.value);
	}

	set hitpoints(value) {
		this._input_hitpoints.value = value;
		this.refreshHealthBar();
	}

	/**
	 * Update the hitpoint display, ensuring the value set is between 0 and the
	 * maximum hitpoint value determined by the character's hp stat.
	 */
	refreshHealthBar() {
		if (this.hitpoints > this.cache.stats.hp) {
			this.hitpoints = this.cache.stats.hp;
		} else if (this.hitpoints < 0) {
			this.hitpoints = 0;
		} else {
			// due to recursive setters, this gets once regarless of the result
			this._output_hitpoints.value = this.hitpoints;
			this.cache.stats.current_hp  = this.hitpoints; 
		}
	}

	/**
	 * Fill the current hitpoints to a maximum hitpoint value determined by the
	 * character's hp stat.
	 */
	fillHealthBar() {
		this.hitpoints = this.cache.stats.hp;
		this.refreshHealthBar();
	}

	/**
	 * Whether or not this character is mounted
	 * @type {boolean}
	 */
	get mounted() {
		return this._input_mounted.checked;
	}

	set mounted(value) {
		this._input_mounted.checked = value;
		this.refreshMounted();
	}

	/**
	 * Recalculate stats when mounted status changes; prevent mounted from being
	 * set to true for classes that do not have access to a mount.
	 */
	refreshMounted() {
		if (this.mounted && !this.class.hasMount()) {
			// do not permit this box to be checked if there is no mount
			this.mounted = false;
		} else {
			// otherwise the state has changed an stats need recalculated
			this.refreshAllStats();
		}
	}

	/**
	 * When class is changed, change class abilities and reculculate stats
	 * @param {array} active - an array of active abilities 
	 */
	refreshClass(active=[]) {

		this.class = Class.byName.get(
			document.getElementById("character-class").value
		);

		// account for whether the character is mounted before stat calcs
		this._input_mounted.checked = this.class.hasMount();

		this.abilities.class.setState({
			added: this.class.abilities,
			active: active
		});

		for (let stat of this.data.stats.names) {
			this.refreshStat(stat);
			this.refreshGrowth(stat);
		}

		this.refreshSecondaryStats();
	}

	/**
	 * The character's current weapon triangle effect
	 * @type {numberS}
	 */
	get triangle() {
		return Number(this._select_triangle.value);
	}

	/* methods relating to grades and skill levels */

	/**
	 * Compute and display the letter grade for a single skill
	 * @param {string} skill - name of the skill
	 */
	refreshGrade(name) {
		const base   = "skill-" + name;
		const points = Number(document.getElementById(base).value);
		const grade  = Grade.for(points);

		this.skills[name] = points;
		document.getElementById(base + "-grade").textContent = grade;
	}

	/**
	 * Compute and display the letter grades for all skills
	 */
	refreshGrades() {
		for (let name of this.data.skills) {
			this.refreshGrade(name);
		}
	}

	/* methods relating to stats and growths */

	/**
	 * Recompute and display the growth rate for a single stat
	 * @param {string} name - name of the stat
	 */
	refreshGrowth(name) {
		// TODO figure out a way to replace this with a set
		if (!this.data.stats.names.includes(name)) {
			console.log("Tried to refresh invalid growth \"" + name + "\"");
			return;
		}

		if (name == "mov") return; // We don't do movement growth here.

		const display = document.getElementById(name + "-growth-total");
		const base    = Number(document.getElementById(name + "-growth-base").value);
		
		this.growths[name] = base;

		const growth = Math.max(
			base + Number(this.class.growths[name]),
			0,
		);

		this.cache.growths[name] = growth;
		display.textContent      = growth + "%";
	}

	/**
	 * Recompute and display a single primary stat
	 * @param {string} name - name of the stat
	 */
	refreshStat(name) {
		// TODO figure out a way to replace this with a set
		if (!this.data.stats.names.includes(name)) {
			console.log("Tried to refresh invalid statistic \"" + name + "\"");
			return;
		}

		const display = document.getElementById(name + "-total");
		const base    = Number(document.getElementById(name + "-base").value);
		const value   = Math.max(
			((name == "mov" ? 4 : 0)
				+ this.class.modifier(name, this.mounted)
				+ this.modifier(name)
				+ base)
			* this.multiplier(name),
			0
		); 

		this.stats[name]       = base;
		this.cache.stats[name] = value;
		display.textContent    = value;

		if (name == "hp") {
			const display   = document.getElementById("hitpoints");
			display.max     = this.cache.stats.hp;
			display.optimum = this.cache.stats.hp;
			display.high    = Math.floor(this.cache.stats.hp / 2);
			display.low     = Math.floor(this.cache.stats.hp / 4) + 1;
			this.refreshHealthBar();
		}

		this.refreshSecondaryStats();
	}

	/**
	 * Recompute and display a all primary stats
	 */
	refreshPrimaryStats() {
		for (let name of this.data.stats.names) {
			this.refreshStat(name);
		}
	}

	/**
	 * Recompute and display all secondary stats
	 */
	refreshSecondaryStats() {
		for (let [base, mod] of this.data.stats.linked) {
			const value = this.calcSecondaryStat(base, mod, this.cache);
			this.cache.stats[mod] = value;
			document.getElementById(mod + "-total").textContent = value;
		}
	}

	abilityIter() {
		return chain(
			this.abilities.class,
			this.abilities.equipped,
			this.abilities.battlefield,
		);	
	}

	/**
	 * Preform an accumulation on a single statistic of all active class,
	 * equipped, and battlefield modifier or mulitplier objects, as if they
	 * were a collection
	 * @param {string} stat - the stat to reduce on
	 * @param {string} kind - either "modifier" or "mulitplier"
	 * @param {number} base - value to use if a property does not exist
	 * @param {function} func - the reduce function, takes two number arguments
	 * @returns {number} the result of the reduction
	 */
	accumulateAbilities(stat, kind, base, func) {

		let acc = base;

		for (let category of ["class", "equipped", "battlefield"]) {
			for (let name of this.abilities[category].getActive()) {
				acc = func(acc, Ability.get(name)[kind](stat));
			}
		}

		return acc;
	}

	abilityModifer(stat) {
		return this.accumulateAbilities(stat, "modifier", 0, (x, y) => x + y);
	}

	abilityMultiplier(stat) {
		return this.accumulateAbilities(stat, "multiplier", 1, (x, y) => x * y);
	}

	/**
	 * Preform an accumulation on single state from all active features
	 * weapons, equipment, and combat arts, as if they were a collection
	 * @param {string} property - the stat to reduce on
	 * @param {number} default_value - value to use if a property does not exist
	 * @param {string} kind - either "modifiers" or "mulitpliers" for abilities
	 * @param {function} func - the reduce function, takes two number arguments
	 * @returns {number} the result of the reduction
	 */
	accumulate(stat, kind, base, func) {

		let acc = this.accumulateAbilities(stat, kind, base, func);

		acc = func(acc, Weapon.get(this.weapons.known.getActive())[kind](stat));
		acc = func(acc, Equipment.get(this.equipment.known.getActive())[kind](stat));
		acc = func(acc, CombatArt.get(this.combatarts.equipped.getActive())[kind](stat));

		return acc;
	}

	/**
	 * Get the sum of the modifiers for a single property for all active
	 * abilities, weapons, equiptment, and combat arts
	 * @param {string} name - name of the stat property
	 * @returns {number} the sum of all modifiers
	 */
	modifier(name) {
		return this.accumulate(name, "modifier", 0, (x, y) => x + y);
	}

	/**
	 * Get the product of the multipliers for a single property for all active
	 * abilities
	 * @param {string} name - name of the stat property
	 * @returns {number} the product of all multipliers
	 */
	multiplier(name) {
		return this.accumulate(name, "multiplier", 1, (a, b) => a * b);
	}

	/**
	 * Compute the value of a secondary stat using the cached value of a primary
	 * stat and the values of all active modifiers and mulitpliers that apply
	 * @param {string} prime - name of a primary stat
	 * @param {string} second - name of a secondary stat
	 * @returns {number} the value of the secondary stat
	 */
	calcSecondaryStat(prime, second) {

		const weapon = Weapon.get(this.weapons.known.getActive());
		const equip  = Equipment.get(this.equipment.known.getActive());
		const art    = CombatArt.get(this.combatarts.equipped.getActive());

		switch (second) {
		case "pdr":
		case "mdr":
			return Math.max(
				(this.cache.stats[prime]
					+ this.modifier(second))
				* this.multiplier(second),
				0,
			);

		case "hit":
		case "avo":
			return Math.max( 
				(this.cache.stats[prime]
					+ this.modifier(second))
				* this.multiplier(second)
					+  this.triangle,
				0,
			);

		case "pmt": {
			const scale = art.multiplier("scale");
			return Math.max(
				Math.floor(
					(this.cache.stats.str
						+ (art.isMagicDamage()
							? 0
							: weapon.modifier(second) + art.modifier(second))
						+ (scale != 1
							? Math.floor(this.cache.stats[scale] * 0.3)
							: 0)
						+ (art.tag("vengeance")
							? Math.floor(
								(-this.hitpoints + this.cache.stats.hp) / 2)
							: 0)
						+ equip.modifier(second)
						+ this.abilityModifer(second))
					* this.multiplier(weapon)
					* (art.tag("astra") ? 0.3 : 1.0)),
				0,
			);
		}

		case "mmt": {
			const scale = art.multiplier("scale");
			return Math.max(
				Math.floor(
					((this.cache.stats.mag
						* (weapon.tag("healing") ? 0.5 : 1))
						+ (art.isMagicDamage()
							? weapon.higherMight()
							: weapon.modifier(second))
						+ (weapon.isMagicDamage()
							? art.higherMight()
							: art.modifier(second))
						+ (scale != 1
							? Math.floor(this.cache.stats[scale] * 0.3)
							: 0)
						+ equip.modifier(second)
						+ this.abilityModifer(second))
					* this.multiplier(weapon)),
				0,
			);
		}

		case "crit":
			return Math.max(
				Math.floor(
					(this.cache.stats[prime] / 2
						+ this.modifier(second))
					* this.multiplier(second)
				),
				0
			);

		case "maxrng":
		case "minrng":
			return (
				((art.modifier(second) || weapon.modifier(second))
					+ equip.modifier(second)
					+ this.abilityModifer(second))
				* this.multiplier(second)
			);

		case "uses":
			return (
				weapon.modifier(second)
					* this.abilityMultiplier(weapon.name)
					* this.abilityMultiplier(weapon.type)
			);

		case "cost":
			return (
				weapon.modifier(second) + art.modifier(second)
			);

		default:
			console.log("Invalid weapon '" + second + "'for computed statistic");
			return;
		}
	}

	/**
	 * Recompute and redisplay all primary and secondary stats
	 */
	refreshAllStats() {
		this.refreshPrimaryStats();
		this.refreshSecondaryStats();
	}

	/* catch all refresh method */

	/**
	 * Recompute all parts of the sheet that don't automatically update
	 */
	refresh() {
		this.refreshClass();
		this.refreshAllStats();
		this.refreshGrades();
		this.refreshLevel();
	}

	/* methods relating to persisting the sheet */

	blurb() {
		const text = [];

		text.push(this.name, "\n\n");
		for (let name of this.data.stats.names) {
			text.push(name.toUpperCase(), ": ", this.cache.stats[name], "\n");
		}
		text.push("\n");

		function doPushFeatures(title, category) {

			if (!category.size) return;

			text.push(title, "\n\n");
			for (let item of category) {
				text.push(item.title(), "\n", item.body(), "\n\n");
			}
		}

		doPushFeatures("Class Abilities", this.abilities.class);
		doPushFeatures("Equipped Abilities", this.abilities.equipped);
		doPushFeatures("Combat Arts", this.combatarts.equipped);
		doPushFeatures("Weapons & Spells", this.weapons.known);
		doPushFeatures("Equipment", this.equipment.known);

		const blurb = text.join("");
		// (navigator.clipboard.writeText(blurb)
		// 	.then((value) => {
		// 		alert("Character blurb copied to clipboard!");
		// 		console.log(blurb);
		// 	})
		// 	.catch((error) => {
		// 		alert(error);
		// 		console.log(error);
		// 	})
		// );
		
		document.getElementById("generator-output").value = blurb;
	}

	macro() {
		const myWeaponName = this.weapons.known.getActive();

		if (!myWeaponName) {
			alert("No weapon or spell selected.");
			return;
		}

		const hardcode = confirm(
			"Hardcode stats? (If yes, you need new macros every level)"
		);

		const m = new MacroBuilder(this.name);

		const weapon    = Weapon.get(myWeaponName);
		const equip     = Equipment.get(this.equipment.known.getActive());
		const art       = CombatArt.get(this.combatarts.equipped.getActive());
		const isMagic   = weapon.isMagicDamage() || art.isMagicDamage();
		const prowess   = weapon.getBestProwessOf(this.abilities.equipped);

		const createPrompts = (...stats) => {
			let prompts = [];

			for (let stat of stats) {
				for (let ability of this.abilityIter()) {

					/* make sure there's even a modifier */
					if (!ability.modifier(stat)) {
						continue;
					}

					/* filter out dependant abilities for other weapons */
					if (ability.weapon && ability.weapon != weapon.type) {
						continue;
					}

					/* filter out non-prompt abilities */
					if (ability.type != "Prompt") {
						continue;
					}

					const text   = ability.name + " (" + stat + ")?";
					const prompt = m.prompt(text,
						"No"  ,                      0,
						"Yes" , ability.modifier(stat),
					);
					prompts.push(prompt.join(""));
				}
			}

			return prompts.length ? prompts.join("+") : null;
		};

		const createPassives = (...stats) => {
			let passives = [];

			for (let stat of stats) {
				for (let ability of this.abilityIter()) {
					/* make sure there's even a modifier */
					if (!ability.modifier(stat)) {
						continue;
					}

					/* filter out non-passive abilities */
					if (ability.type != "Passive") {
						continue;
					}
				
					/* filter out dependant abilities for other weapons */
					if (ability.weapon && ability.weapon != weapon.type) {
						continue;
					}
					
					/* filter out prowess abililities, which are handled separately */
					if (ability.name.includes("Lv")) {
						continue;
					}

					/* make sure heal status lines up */
					if (weapon.tag("healing") != ability.tag("healing")) {
						continue;
					}
					console.log(ability);

					passives.push(ability.modifier(stat));
				}
			}

			return passives.length ? passives.join("+") : null;
		};

		if (weapon.tag("healing")) {
			/* this a healing effect */
			(m
				.me("(FLAVOR TEXT GOES HERE)")
				.table()
				.row("name", String(weapon.name))
				.row("Healing",
					m.sum(
						(hardcode
							? Math.floor(this.cache.stats.mag/2)
							: m.call("floor", m.character("Mag") + "/2")),
						weapon.modifier("mmt"),
						createPassives("mmt"))));

			confirm("Healing is experimental and may not be correct");

		} else if (weapon.higherMight() == 0) {
			/* this is another effect */
			(m
				.me("(FLAVOR TEXT GOES HERE)")
				.table()
				.row("name", String(weapon.name)));

			confirm("Non-damaging spells are experimental and may not be correct");

		} else {
			/* this is an attack */
			(m
				.me("(FLAVOR TEXT GOES HERE)")
				.table()
				.row("name", String(weapon.name)
					+ (art != CombatArt.EMPTY
						? " w/ " + art.name
						: ""))
				.row("To Hit", m.sum("1d100"))
				.row("Hit at or below",
					m.sum(
						(hardcode
							? this.cache.stats.dex
							: m.character("Dex")),
						weapon.modifier("hit"),
						(art != CombatArt.EMPTY
							? art.modifier("hit")
							: null),
						(prowess
							? prowess.modifier("hit")
							: null),
						createPassives("hit"),
						createPrompts("hit", "dex"),
						(weapon.type == "Bow"
							? m.prompt("Range Penalty",
								"One Extra",            0,
								"Two Extra",          -20,
								"Three Extra",        -30,
								"Four or More Extra", -40)
							: null),
						m.prompt("Triangle Effect?",
							"Neutral"      ,   0,
							"Advantage"    ,  15,
							"Disadvantage" , -15)))
				.row("Damage is",
					m.sum(
						(hardcode
							? (isMagic
								? this.cache.stats.mag
								: this.cache.stats.str)
							: (isMagic
								? m.character("Mag")
								: m.character("Str"))),
						weapon.higherMight(),
						(art != CombatArt.EMPTY
							? art.higherMight()
							: null),
						(isMagic
							? createPassives("mmt")
							: createPassives("pmt")),
						(isMagic
							? createPrompts("mag", "mmt")
							: createPrompts("str", "pmt"))))
				.row("To Crit", m.sum("1d100"))
				.row("Crit at or below",
					m.sum(
						/** @TODO ingoring dex prompts for now */ 
						(hardcode
							? Math.floor(this.cache.stats.dex/2)
							: m.call("floor", m.character("Dex") + "/2")),
						weapon.modifier("crit"),
						(art != CombatArt.EMPTY
							? art.modifier("crit")
							: null),
						createPassives("crit"),
						createPrompts("crit"))));
		}

		/* all actions need avoid and speed */
		(m
			.row("Avoid",
				m.sum(
					(hardcode
						? this.cache.stats.spd
						: m.character("Spd")),
					weapon.modifier("avo"),
					(art != CombatArt.EMPTY
						? art.modifier("avo")
						: null),
					(prowess
						? prowess.modifier("avo")
						: null),
					createPassives("avo"),
					createPrompts("spd", "avo")))
			// .row("Defense",
			// 	m.sum(
			// 		(hardcode
			// 			? this.cache.stats.def
			// 			: m.character("Def"),
			// 		createPassives("pdr"),
			// 		createPrompts("def", "pdr"))))
			// .row("Resistance",
			// 	m.sum(
			// 		(hardcode
			// 			? this.cache.stats.res
			// 			: m.character("Res"),
			// 		createPassives("mdr"),
			// 		createPrompts("res", "mdr"))))
			// .row("Speed",
			// 	m.sum(
			// 		(hardcode
			// 			? this.cache.stats.spd
			// 			: m.character("Spd"))))
		);

		console.log(this.cache.stats);
		
		const macro = m.macro();
		console.log(macro);
		document.getElementById("generator-output").value = macro;
	}

	readCharacter(char) {
		// console.log(char);

		if (!("version" in char) || char.version == "1.12.0") {
			this.readCharacter_v1_13_0(char);
			return;
		}

		this.class = Class.get(char.class);
		if (this.class.hasMount()) {
			this._input_mounted.checked = true;
		}

		document.getElementById("character-class").value = char.class;

		// minor bookeeping and intialization of data structures
		for (let feature of [Ability, CombatArt, Weapon, Equipment]) {
			for (let category in this[feature.kind]) {
				if (category == "class") continue;
				this[feature.kind][category].setState(
					char[feature.kind][category]
				);
			}
		}

		// fill the statistics boxes
		for (let statistic of this.data.stats.names) {
			document.getElementById(statistic + "-base").value =
				char.statistics[statistic];

			if (statistic == "mov") continue;

			document.getElementById(statistic + "-growth-base").value =
				char.growths[statistic];
		}

		// fill the skills boxes
		for (let skill of this.data.skills) {
			document.getElementById("skill-" + skill).value =
				char.skills[skill];
		}

		this.refreshClass(char.class_active);
		this.refreshAllStats();
		this.refreshGrades();
		this.refreshLevel();

		// fill the "character and backstory" section entries
		this.name        = char.name;
		this.homeland    = char.homeland;
		this.description = char.description;
		this.hitpoints   = char.hitpoints;
		this.level       = char.experience;
		// this.levelups    = char.progression;
	}

	readCharacter_v1_13_0(char) {
		this.class = Class.byName.get(char.class);
		if (this.class.hasMount()) {
			this._input_mounted.checked = true;
		}

		document.getElementById("character-class").value = char.class;

		// minor bookeeping and intialization of data structures
		for (let feature of [Ability, CombatArt, Weapon, Equipment]) {
			for (let category in this[feature.kind]) {
				if (feature.kind in char && category != "class") {
					this[feature.kind][category].fill_from(
						char[feature.kind][category]
					);
				} else {
					this[feature.kind][category].clear();
				}
			}
		}

		const toggleAllActive = ((category, names) => {
			for (let name of names) {
				category.toggleActive(name);
			}
		});

		toggleAllActive(this.abilities.known, this.abilities.equipped.names());
		toggleAllActive(this.combatarts.known, this.combatarts.equipped.names());

		// fill the statistics boxes
		for (let statistic of this.data.stats.names) {
			document.getElementById(statistic + "-base").value =
				char.statistics[statistic];

			if (statistic == "mov") continue;

			document.getElementById(statistic + "-growth-base").value =
				char.growths[statistic];
		}

		// fill the skills boxes
		for (let skill of this.data.skills) {
			document.getElementById("skill-" + skill).value =
				char.skills[skill];
		}

		this.refresh();

		// fill the "character and backstory" section entries
		this.name        = char.name;
		this.homeland    = char.homeland || char.home; // used to be home
		this.description = char.description;
		this.hitpoints   = char.hitpoints;
		this.level       = char.level;
	}

	/** @todo remove when version is finalized */
	writeCharacter_v1_13_0() {
		return {
			name        : this.name,
			description : this.description,
			class       : this.class.name,
			homeland    : this.homeland,
			hitpoints   : this.hitpoints,
			level       : this.level,
			growths     : this.growths,
			statistics  : this.stats,
			skills      : this.skills,
			abilities   : {
				equipped    : Array.from(this.abilities.equipped.names()),
				battlefield : Array.from(this.abilities.battlefield.names()),
				known       : Array.from(this.abilities.known.names())
			},
			combatarts  : {
				equipped    : Array.from(this.combatarts.equipped.names()),
				known       : Array.from(this.combatarts.known.names())
			},
			weapons     : {
				known       : Array.from(this.weapons.known.names())
			},
			equipment   : {
				known       : Array.from(this.equipment.known.names())
			}
		};
	}

	async getProgression() {
		const buffer = LevelStamp.packBlock(this.levelups);
		
		let raw = await window.crypto.subtle.digest("SHA-256", buffer);

		return {
			value: btoa(buffer),
			digest: btoa(raw),
		};
	}

	async setProgression(value) {
		
		const buffer = new Uint32Array(
			atob(value.value).split(",").map(Number)
		);

		const raw    = await window.crypto.subtle.digest("SHA-256", buffer);
		const digest = btoa(raw);

		console.log(digest, value.digest);

		if (value.digest && digest != value.digest) {
			alert("The progression data has been compromised.");
		}

		this.levelups = LevelStamp.unpackBlock(buffer);
	}

	writeCharacter() {
		return {
			version      : VERSION,
			name         : this.name,
			description  : this.description,
			class        : this.class.name,
			homeland     : this.homeland,
			hitpoints    : this.hitpoints,
			experience   : this.level,
			growths      : this.growths,
			statistics   : this.stats,
			skills       : this.skills,
			// progression  : this.progression,

			/*
			 * don't save the actual state for class since this will be
			 * loaded when the class is assigned; only save active abilites
			 * yes, I realize it's a little clunky but that's how it is
			 */
			class_active : Array.from(this.abilities.class.getActive()),

			abilities    : {
				equipped    : this.abilities.equipped.getState(),
				battlefield : this.abilities.battlefield.getState(),
				known       : this.abilities.known.getState()
			},
			combatarts  : {
				equipped    : this.combatarts.equipped.getState(),
				known       : this.combatarts.known.getState()
			},
			weapons     : {
				known       : this.weapons.known.getState()
			},
			equipment   : {
				known       : this.equipment.known.getState()
			}
		};
	}


	clear() {
		this.class = Class.get("Commoner");

		if (this.class.hasMount()) {
			this._input_mounted.checked = true;
		}

		document.getElementById("character-class").value = this.class.name;

		// minor bookeeping and intialization of data structures
		for (let feature of [Ability, CombatArt, Weapon, Equipment]) {
			for (let category in this[feature.kind]) {
				if (category == "class") continue;
				this[feature.kind][category].clear();
			}
		}

		// fill the statistics boxes
		for (let statistic of this.data.stats.names) {
			document.getElementById(statistic + "-base").value = 0;
			if (statistic == "mov") continue;
			document.getElementById(statistic + "-growth-base").value = 0;
		}

		// fill the skills boxes
		for (let skill of this.data.skills) {
			document.getElementById("skill-" + skill).value = 0;
		}

		this.refresh();

		// fill the "character and backstory" section entries
		this.name        = "Blank Sheet";
		this.homeland    = "adrestia";
		this.description = "Write your character description here.";
		this.hitpoints   = 0;
		this.level       = 0;
	}

	fresh() {
		if (this.characters.size > 0) {
			this.myCharMap.set(this.charID, this.writeCharacter());
		}
		
		/* new character must be created before clearing the sheet */
		const charID = this.createID();

		/* add in a stub until the form is filled out */
		this.myCharMap.set(charID, {
			name: this.name,
			description: this.description
		});

		this.characters.add(charID);
		this.characters.toggleActive(charID);

		this.charID  = charID;

		/* side effects on syncing the name field with the sidebar */
		this.clear();
	}

	/**
	 * Create a download prompt for a .json file to persist sheet data
	 */
	export() {
		const a    = document.createElement("a");
		const char = this.writeCharacter();
		const file = new Blob([JSON.stringify(char, null, 4)], {type: "application/json"});
		a.href     = URL.createObjectURL(file);
		a.download = this.name.replace(/ /g, "_") + ".json";
		a.click();
		URL.revokeObjectURL(a.href);
	}

	/**
	 * Fill out the sheet with the data from a user uploaded .json file
	 * @param {Event} e - upload event containing sheet data
	 */
	import(e) {
		const file = e.target.files[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = (e) => {
			const char   = JSON.parse(e.target.result);
			const charID = this.createID();
			this.myCharMap.set(charID, char);
			this.characters.add(charID);
			this.changeCharacter(charID);
		};
		reader.readAsText(file);
	}
}

/* exported Sheet */