export function calculateInventoryValue(items=[]){
 return items.reduce((t,i)=>t+((i.currentStock||0)*(i.unitCost||0)),0);
}
export function calculateWasteValue(waste=[]){
 return waste.reduce((t,w)=>t+((w.qty||0)*(w.unitCost||0)),0);
}