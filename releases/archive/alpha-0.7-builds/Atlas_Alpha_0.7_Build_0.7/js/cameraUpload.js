export function initCameraUpload(){
  const camera=document.getElementById('camera-input');
  const gallery=document.getElementById('gallery-input');
  const container=document.getElementById('image-gallery');

  function render(files){
    [...files].forEach(file=>{
      const reader=new FileReader();
      reader.onload=e=>{
        const img=document.createElement('img');
        img.src=e.target.result;
        img.alt=file.name;
        container.appendChild(img);
      };
      reader.readAsDataURL(file);
    });
  }

  camera?.addEventListener('change',e=>render(e.target.files));
  gallery?.addEventListener('change',e=>render(e.target.files));
}
