(() => {
  const search=document.getElementById('search'),tag=document.getElementById('tag');
  if(search && tag){
    const update=()=>{let count=0;document.querySelectorAll('.entry').forEach(el=>{const match=el.dataset.search.includes(search.value.trim().toLowerCase())&&(!tag.value||JSON.parse(el.dataset.tags).includes(tag.value));el.hidden=!match;if(match)count++;});document.getElementById('no-results').hidden=count>0;};
    search.addEventListener('input',update);tag.addEventListener('change',update);
  }
  document.querySelectorAll('.codehilite').forEach(block=>{
    const button=document.createElement('button');button.className='copy';button.textContent='코드 복사';
    button.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(block.querySelector('code').textContent);button.textContent='복사됨';}catch{button.textContent='코드를 선택해 복사하세요';}setTimeout(()=>button.textContent='코드 복사',2000);});block.prepend(button);
  });
})();
