console.log('script loaded');

// Phone mockup hover interactions
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded');
    const phones = document.querySelectorAll('.phone');
    console.log('Number of phones found:', phones.length);
    
    // Function to reset all phones
    function resetAllPhones() {
        phones.forEach(p => {
            p.style.transform = 'scale(0.85)';
            p.style.opacity = '0.5';
        });
    }
    
    // Function to activate a phone
    function activatePhone(phone) {
        phone.style.transform = 'scale(1)';
        phone.style.opacity = '1';
    }
    
    // Function to activate all phones (for mobile)
    function activateAllPhones() {
        phones.forEach(p => {
            p.style.transform = 'scale(1)';
            p.style.opacity = '1';
        });
    }
    
    // Check if mobile
    function isMobile() {
        return window.innerWidth <= 768;
    }
    
    // Update phone states based on screen size
    function updatePhoneStates() {
        if (isMobile()) {
            activateAllPhones();
        } else {
            resetAllPhones();
            if (phones.length > 0) {
                activatePhone(phones[0]);
            }
        }
    }
    
    // Initial setup
    updatePhoneStates();
    
    // Add hover listeners (only work on desktop due to mouse events)
    phones.forEach(phone => {
        phone.addEventListener('mouseenter', function() {
            if (!isMobile()) {
                console.log('Phone hovered');
                resetAllPhones();
                activatePhone(phone);
            }
        });
    });
    
    // Update on window resize
    window.addEventListener('resize', updatePhoneStates);
});