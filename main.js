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
    
    // Activate first phone on load
    resetAllPhones();
    if (phones.length > 0) {
        activatePhone(phones[0]);
        console.log('First phone activated');
    }
    
    // Add hover listeners
    phones.forEach(phone => {
        phone.addEventListener('mouseenter', function() {
            console.log('Phone hovered');
            resetAllPhones();
            activatePhone(phone);
        });
    });
});