// Phone mockup hover interactions
document.addEventListener('DOMContentLoaded', function() {
    const phoneContainers = document.querySelectorAll('.phone-container');
    
    phoneContainers.forEach(container => {
        container.addEventListener('mouseenter', function() {
            phoneContainers.forEach(other => {
                if (other !== container) {
                    other.style.transform = 'scale(0.9)';
                    other.style.opacity = '0.5';
                }
            });
            container.style.transform = 'scale(1.1)';
            container.style.opacity = '1';
        });
        
        container.addEventListener('mouseleave', function() {
            phoneContainers.forEach(other => {
                other.style.transform = 'scale(1)';
                other.style.opacity = '0.7';
            });
        });
    });
});
