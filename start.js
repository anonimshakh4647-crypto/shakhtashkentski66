/* IT SHAKH START SCREEN - separate file */
(function(){
    const screen = document.getElementById('shakh-start-screen');
    const button = document.getElementById('shakh-start-button');
    const music = document.getElementById('shakh-music');

    if(!screen || !button || !music) return;

    button.addEventListener('click', function(){
        music.volume = 0.65;
        music.play().catch(function(){});

        screen.classList.add('hide');

        setTimeout(function(){
            screen.remove();
        }, 850);
    });
})();
