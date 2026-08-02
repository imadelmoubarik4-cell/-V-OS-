export function forecastDaysRemaining(product){
  const usage=product.averageDailyUsage||0;
  if(usage<=0) return Infinity;
  return Number(((product.currentStock||0)/usage).toFixed(1));
}
