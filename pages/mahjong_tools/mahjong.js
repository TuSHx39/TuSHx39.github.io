const poketInput = document.getElementById('poket');
const checkButton = document.getElementById('checking')
let poket = poketInput.value.toString().split("");

function check(poket){
    const fullPoket = [...poket]
    for(let i= 1; i<10; i++){
        fullPoket.push(i);
        fullPoket.sort((a, b) => a - b);
        console.log(fullPoket);
    }
    
}

checkButton.addEventListener('click', () =>{
    check(poket)
})