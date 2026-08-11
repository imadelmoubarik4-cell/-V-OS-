export function renderProductProfile(product){
  document.getElementById('product-name').textContent = product.name;
  document.getElementById('product-category').textContent = product.category;
  document.getElementById('product-supplier').textContent = product.supplier;
  document.getElementById('current-stock').textContent = product.currentStock;
  document.getElementById('par-level').textContent = product.parLevel;
  document.getElementById('unit-cost').textContent = `${product.unitCost} ISK`;
  document.getElementById('average-cost').textContent = `${product.averageCost} ISK`;
  document.getElementById('product-image').src = product.image || '';

  const recipes = document.getElementById('recipe-links');
  recipes.innerHTML='';
  (product.recipeLinks||[]).forEach(r=>{
    const li=document.createElement('li');
    li.textContent=r;
    recipes.appendChild(li);
  });

  const body=document.querySelector('#movement-table tbody');
  body.innerHTML='';
  (product.movements||[]).forEach(m=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${m.date}</td><td>${m.type}</td><td>${m.qty}</td>`;
    body.appendChild(tr);
  });
}
