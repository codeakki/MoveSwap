module htlc_swap::htlc {
    use sui::object::{Self, UID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::clock::{Self, Clock};
    use sui::event;
    use std::hash;
    use std::vector;
    use std::option::{Self, Option};

    /// Error codes
    const E_INVALID_SECRET: u64 = 2;
    const E_ALREADY_WITHDRAWN: u64 = 3;
    const E_ALREADY_REFUNDED: u64 = 4;
    const E_TIMELOCK_NOT_EXPIRED: u64 = 5;
    const E_TIMELOCK_EXPIRED: u64 = 6;
    const E_UNAUTHORIZED: u64 = 7;
    const E_INVALID_HASHLOCK_LENGTH: u64 = 8;

    /// HTLC structure as a Sui object
    struct HTLC has key, store {
        id: UID,
        htlc_id: vector<u8>,
        hashlock: vector<u8>,
        timelock: u64,
        sender: address,
        receiver: address,
        amount: u64,
        secret: vector<u8>,
        withdrawn: bool,
        refunded: bool,
        created_at: u64,
        coin: Option<Coin<SUI>>
    }

    /// Events
    struct HTLCCreatedEvent has copy, drop {
        htlc_id: vector<u8>,
        sender: address,
        receiver: address,
        amount: u64,
        hashlock: vector<u8>,
        timelock: u64
    }

    struct HTLCClaimedEvent has copy, drop {
        htlc_id: vector<u8>,
        receiver: address,
        secret: vector<u8>,
        amount: u64
    }

    struct HTLCRefundedEvent has copy, drop {
        htlc_id: vector<u8>,
        sender: address,
        amount: u64
    }


    // The function signature must change. It should NOT take an 'htlc' parameter.
public entry fun create_htlc(
    clock: &Clock,
    htlc_id: vector<u8>,
    receiver: address,
    hashlock: vector<u8>,
    timelock: u64,
    payment: Coin<SUI>,
    ctx: &mut TxContext
) {
    // ... (input validation logic remains the same) ...

    // Create the HTLC object within the function.
    // Get payment amount
    let amount = coin::value(&payment);

    let htlc = HTLC {
        id: object::new(ctx),
        htlc_id,
        hashlock,
        timelock,
        sender: tx_context::sender(ctx),
        receiver,
        amount,
        secret: vector::empty(),
        withdrawn: false,
        refunded: false,
        created_at: clock::timestamp_ms(clock) / 1000,
        coin: option::some(payment)
    };

    // Emit event
    event::emit(HTLCCreatedEvent {
        htlc_id,
        sender: tx_context::sender(ctx),
        receiver,
        amount,
        hashlock,
        timelock
    });

    // Transfer the HTLC object to the shared state so it can be found by others.
    // Use 'transfer::public_share_object' to make it freely accessible.
    transfer::public_share_object(htlc);
}
    /// Claim HTLC with secret
    public entry fun claim_with_secret(
        clock: &Clock,
        htlc: &mut HTLC,
        secret: vector<u8>,
        ctx: &mut TxContext
    ) {
        let receiver = tx_context::sender(ctx);
        
        // Verify receiver
        assert!(htlc.receiver == receiver, E_UNAUTHORIZED);

        // Check not already withdrawn or refunded
        assert!(!htlc.withdrawn, E_ALREADY_WITHDRAWN);
        assert!(!htlc.refunded, E_ALREADY_REFUNDED);

        // Check timelock not expired
        let current_time = clock::timestamp_ms(clock) / 1000;
        assert!(current_time < htlc.timelock, E_TIMELOCK_EXPIRED);

        // Verify secret matches hashlock
        let secret_hash = hash::sha2_256(secret);
        assert!(secret_hash == htlc.hashlock, E_INVALID_SECRET);

        // Store revealed secret and mark as withdrawn
        htlc.secret = secret;
        htlc.withdrawn = true;

        // Transfer funds to receiver
        let coin = option::extract(&mut htlc.coin);
        transfer::public_transfer(coin, receiver);

        // Emit event
        event::emit(HTLCClaimedEvent {
            htlc_id: htlc.htlc_id,
            receiver,
            secret,
            amount: htlc.amount
        });
    }

    /// Refund HTLC after timelock expiry
    public entry fun refund_htlc(
        clock: &Clock,
        htlc: &mut HTLC,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);

        // Verify sender
        assert!(htlc.sender == sender, E_UNAUTHORIZED);

        // Check not already withdrawn or refunded
        assert!(!htlc.withdrawn, E_ALREADY_WITHDRAWN);
        assert!(!htlc.refunded, E_ALREADY_REFUNDED);

        // Check timelock has expired
        let current_time = clock::timestamp_ms(clock) / 1000;
        assert!(current_time >= htlc.timelock, E_TIMELOCK_NOT_EXPIRED);

        htlc.refunded = true;

        // Return funds to sender
        let coin = option::extract(&mut htlc.coin);
        transfer::public_transfer(coin, sender);

        // Emit event
        event::emit(HTLCRefundedEvent {
            htlc_id: htlc.htlc_id,
            sender,
            amount: htlc.amount
        });
    }

    /// View functions
    public fun get_htlc_info(htlc: &HTLC): (
        vector<u8>,    // htlc_id
        vector<u8>,    // hashlock
        u64,          // timelock
        address,      // sender
        address,      // receiver
        u64,          // amount
        vector<u8>,    // secret
        bool,         // withdrawn
        bool,         // refunded
        u64           // created_at
    ) {
        (
            htlc.htlc_id,
            htlc.hashlock,
            htlc.timelock,
            htlc.sender,
            htlc.receiver,
            htlc.amount,
            htlc.secret,
            htlc.withdrawn,
            htlc.refunded,
            htlc.created_at
        )
    }

    public fun get_revealed_secret(htlc: &HTLC): vector<u8> {
        htlc.secret
    }
}