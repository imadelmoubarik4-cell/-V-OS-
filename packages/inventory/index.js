export const INVENTORY_CATEGORIES = Object.freeze([
  'Gin',
  'Vodka',
  'Rum',
  'Tequila / Mezcal',
  'Whiskey / Cognac',
  'Liqueur',
  'Vermouth / Aperitivo',
  'Beer & Cider',
  'Beer & Cider (Keg)',
  'Wine',
  'Sparkling',
  'Soda & Mixer',
  'Syrups',
  'Purée & Fresh',
  'Milk',
  'Fresh Herbs',
  'Fresh Fruit',
  'Garnish',
  'Coffee & Tea',
  'Food',
  'Consumables',
  'Glassware',
  'Bar Equipment',
  'Cleaning',
  'Other',
]);

export function inventoryNeedsReview(item) {
  return !item?.name
    || !item?.category
    || !item?.unit
    || Boolean(item?.issues?.length)
    || item?.costPrice === undefined;
}
