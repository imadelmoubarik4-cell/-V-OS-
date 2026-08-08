export function applyAction(row,action){
 return {...row,__action:action}; // merge | create | skip
}
