console.log("network.js has loaded successfully!");

let peer = null;
let connection = null;
window.isHost = false; 
window.amIHost = false; 
window.blockNetworkBroadcast = false;
window.activeCarousels = 0;
window.isEnginePlayingCard = false;

// --- DYNAMIC UI TRANSLATOR ---
setInterval(() => {
    try {
        let meTurn = document.querySelector("#notification-me-turn .text") || document.querySelector("#notification-me-turn p");
        if (meTurn && meTurn.innerText !== "Your Turn") {
            meTurn.innerText = "Your Turn";
        }
        
        let opTurn = document.querySelector("#notification-op-turn .text") || document.querySelector("#notification-op-turn p");
        if (opTurn && opTurn.innerText !== "Opponent's Turn") {
            opTurn.innerText = "Opponent's Turn";
        }

        if (window.networkHostStarts !== undefined) {
            let starterText = window.networkHostStarts ? "Host will start" : "Guest will start";
            let meCoin = document.querySelector("#notification-me-coin .text") || document.querySelector("#notification-me-coin p");
            if (meCoin && !meCoin.dataset.nFix) {
                meCoin.innerText = starterText;
                meCoin.dataset.nFix = "1";
            }
            let opCoin = document.querySelector("#notification-op-coin .text") || document.querySelector("#notification-op-coin p");
            if (opCoin && !opCoin.dataset.nFix) {
                opCoin.innerText = starterText;
                opCoin.dataset.nFix = "1";
            }
        }
    } catch(e) {}
}, 500); 

// --- HELPER: NATIVE REPLAY MATCHING ---
window.serializeCard = function(card) {
    if (!card) return null;
    return { 
        id: typeof card.id === 'function' ? card.id() : (card.id || card.name),
        name: typeof card.name === 'function' ? card.name() : card.name
    };
};

window.matchCard = function(cardObj, targetData) {
    if (!cardObj || !targetData) return false;
    let cId = typeof cardObj.id === 'function' ? cardObj.id() : (cardObj.id || cardObj.name);
    let cName = typeof cardObj.name === 'function' ? cardObj.name() : cardObj.name;
    return String(cId) === String(targetData.id) || String(cName) === String(targetData.name);
};

window.serializeCarouselChoice = function(chosenCard, carouselCards) {
    if (!chosenCard) return null;
    let cId = typeof chosenCard.id === 'function' ? chosenCard.id() : (chosenCard.id || chosenCard.name);
    let identicalCards = carouselCards.filter(c => {
        let id = typeof c.id === 'function' ? c.id() : (c.id || c.name);
        return String(id) === String(cId);
    });
    return { id: cId, instanceId: identicalCards.indexOf(chosenCard) };
};

window.deserializeCarouselChoice = function(targetData, carouselCards) {
    if (!targetData) return null;
    let identicalCards = carouselCards.filter(c => {
        let id = typeof c.id === 'function' ? c.id() : (c.id || c.name);
        return String(id) === String(targetData.id);
    });
    let idx = targetData.instanceId !== -1 ? targetData.instanceId : 0;
    return identicalCards[idx] || identicalCards[0];
};

// --- NATIVE ENGINE INJECTION ---
window.injectMultiplayerHooks = function() {
    if (window.engineHooked || typeof Game === 'undefined') return;
    window.engineHooked = true;
    console.log("Network: Injecting advanced multiplayer hooks with UI execution locks...");

    window.networkCarouselChoices = [];
    window.isReceivingNetworkCards = false;

    if (typeof Player !== 'undefined') {
        const origPlayCard = Player.prototype.playCard;
        Player.prototype.playCard = async function(...args) {
            window.isEnginePlayingCard = true;
            try { return await origPlayCard.apply(this, args); } 
            finally { window.isEnginePlayingCard = false; }
        };

        if (Player.prototype.activateLeader) {
            const origActivateLeader = Player.prototype.activateLeader;
            Player.prototype.activateLeader = async function(...args) {
                window.isEnginePlayingCard = true;
                try { return await origActivateLeader.apply(this, args); } 
                finally { window.isEnginePlayingCard = false; }
            };
        }
    }

    const origCoinToss = Game.prototype.coinToss;
    Game.prototype.coinToss = async function(...args) {
        if (window.amIHost) {
            window.networkHostStarts = (Math.random() < 0.5);
            this.firstPlayer = window.networkHostStarts ? player_me : player_op;
            if (connection && connection.open) {
                connection.send({ type: 'COIN_TOSS_TRUTH', hostStarts: window.networkHostStarts });
            }
            this.currPlayer = this.firstPlayer;
            return await ui.notification(this.firstPlayer.tag + "-coin", 1200);
        } else {
            if (window.networkHostStarts === undefined) {
                await new Promise(resolve => window.resolveCoinTruth = resolve);
            }
            this.firstPlayer = window.networkHostStarts ? player_op : player_me;
            this.currPlayer = this.firstPlayer;
            return await ui.notification(this.firstPlayer.tag + "-coin", 1200);
        }
    };

    const origStartRound = Game.prototype.startRound;
    Game.prototype.startRound = async function(...args) {
        if (typeof connection !== 'undefined' && connection && connection.open) {
            let statusEl = document.getElementById('connection-status');
            if(statusEl) statusEl.innerText = "Waiting for opponent to finish redraw...";

            let finalHandArr = player_me.hand.cards || player_me.hand;
            let syncPayload = { 
                type: 'ROUND_SYNC',
                finalHand: finalHandArr.map(c => window.serializeCard(c))
            };

            if (!window.networkOpponentReadyForRound) {
                connection.send(syncPayload);
                await new Promise(resolve => window.resolveNetworkStartRound = resolve);
            } else {
                connection.send(syncPayload);
            }
            
            if(statusEl) statusEl.innerText = "Game in progress...";
            window.networkOpponentReadyForRound = false; 
        }

        if (!this.round || this.round <= 1) {
            this.firstPlayer = (window.amIHost === window.networkHostStarts) ? player_me : player_op;
            this.currPlayer = this.firstPlayer;
        }

        return await origStartRound.apply(this, args);
    };

    const origQueueCarousel = ui.queueCarousel;
    ui.queueCarousel = async function(cards, ...args) {
        // If we are actively simulating the opponent's turn, auto-resolve using captured choices
        if (window.isReceivingNetworkCards) {
            if (window.networkCarouselChoices && window.networkCarouselChoices.length > 0) {
                let expectedData = window.networkCarouselChoices.shift();
                return window.deserializeCarouselChoice(expectedData, cards);
            } else {
                return (cards && Array.isArray(cards) && cards.length) ? cards.find(c => c !== undefined && c !== null) : null;
            }
        }
        
        // Otherwise, allow the local human UI to proceed (fixes the missing Mulligan phase!)
        window.activeCarousels = (window.activeCarousels || 0) + 1;
        let chosen = null;
        try {
            chosen = await origQueueCarousel.apply(this, [cards, ...args]);
        } finally {
            window.activeCarousels = Math.max(0, window.activeCarousels - 1);
        }
        
        // Record our choice to broadcast to the opponent
        if (chosen && !window.blockNetworkBroadcast) {
            window.networkCarouselChoices.push(window.serializeCarouselChoice(chosen, cards));
        }
        return chosen;
    };

    const originalStartTurn = Player.prototype.startTurn;
    Player.prototype.startTurn = async function(...args) {
        if (this === player_me) {
            let myHandArr = this.hand.cards || this.hand;
            window.myPreviousHand = [...myHandArr];
            window.myPreviousLeaderAvailable = this.leaderAvailable;
            window.networkCarouselChoices = []; 
        }
        return await originalStartTurn.apply(this, args);
    };

    const originalEndTurn = Game.prototype.endTurn;
    Game.prototype.endTurn = function(...args) {
        if (window.isReceivingNetworkCards) return originalEndTurn.apply(this, args);

        if (this.currPlayer === player_me && window.myPreviousHand && !window.blockNetworkBroadcast && !player_me.passed) {
            const attemptBroadcast = () => {
                if (window.activeCarousels > 0 || window.isEnginePlayingCard) {
                    setTimeout(attemptBroadcast, 250); 
                    return;
                }

                let currentHandArr = player_me.hand.cards || player_me.hand;
                let missingCards = [];
                let tempCurrentHand = [...currentHandArr]; 

                for (let oldCard of window.myPreviousHand) {
                    let foundIdx = tempCurrentHand.findIndex(c => window.matchCard(c, window.serializeCard(oldCard)));
                    if (foundIdx !== -1) {
                        tempCurrentHand.splice(foundIdx, 1); 
                    } else {
                        missingCards.push(oldCard);
                    }
                }
                
                let addedCards = tempCurrentHand; 
                let primaryCardObj = missingCards.length > 0 ? missingCards[0] : null;
                let isLeader = window.myPreviousLeaderAvailable && !player_me.leaderAvailable;

                let playedRowIndex = null;

                // FULLPROOF ROW SCANNER: Find the card on the board right now!
                if (primaryCardObj) {
                    for (let r = 0; r < 6; r++) {
                        if (board.row[r].cards.includes(primaryCardObj)) {
                            playedRowIndex = r;
                            break;
                        }
                    }
                }

                if (primaryCardObj || isLeader || addedCards.length > 0) {
                    console.log("NETWORK: Broadcasting turn action. Card Played:", primaryCardObj);
                    if (connection && connection.open) {
                        connection.send({ 
                            type: 'TURN_ACTION_V2', 
                            primaryCard: window.serializeCard(primaryCardObj),
                            targetRowIndex: playedRowIndex,
                            addedCards: addedCards.map(c => window.serializeCard(c)),
                            isLeader: isLeader,
                            carouselChoices: window.networkCarouselChoices || []
                        });
                    }
                }
                window.myPreviousHand = null; 
                window.networkCarouselChoices = []; 
            };
            
            attemptBroadcast();
        }
        
        return originalEndTurn.apply(this, args);
    };
};

// --- NETWORKING ---
window.initPeer = function() {
    try {
        peer = new Peer({ debug: 2 }); 
        peer.on('open', (id) => {
            document.getElementById('my-id').innerText = id; 
            document.getElementById('connection-status').innerText = "Ready to Host or Join.";
        });
        peer.on('error', (err) => {
            document.getElementById('connection-status').innerText = "Connection Error: " + err.type;
        });
        peer.on('connection', (conn) => {
            connection = conn;
            window.isHost = true; window.amIHost = true; 
            window.setupConnection();
            document.getElementById('connection-status').innerText = "Friend joined! Game ready.";
        });
    } catch (error) {}
}

window.hostGame = function() {
    document.getElementById('connection-status').innerText = "Waiting for friend...";
}

window.joinGame = function() {
    const friendId = document.getElementById('join-id').value;
    if (!friendId) return;
    connection = peer.connect(friendId);
    window.isHost = false; window.amIHost = false; 
    
    connection.on('open', () => {
        window.setupConnection();
        document.getElementById('connection-status').innerText = "Connected to host! Game ready.";
    });
}

window.setupConnection = function() {
    if (!connection) return;
    setTimeout(window.injectMultiplayerHooks, 1000);

    connection.on('data', (data) => {
        if (data.type === 'ROUND_SYNC') {
            if (data.finalHand && data.finalHand.length > 0) {
                let opDeckArr = player_op.deck.cards || player_op.deck.deck || player_op.deck;
                let opHandArr = player_op.hand.cards || player_op.hand;
                
                let cardsToReturn = [...opHandArr];
                for (let c of cardsToReturn) {
                    if (typeof player_op.hand.removeCard === 'function') player_op.hand.removeCard(c);
                    else {
                        let idx = opHandArr.indexOf(c);
                        if (idx > -1) opHandArr.splice(idx, 1);
                    }
                    opDeckArr.push(c);
                }

                for (let target of data.finalHand) {
                    let cIdx = opDeckArr.findIndex(c => window.matchCard(c, target));
                    if (cIdx !== -1) {
                        let foundCard = opDeckArr.splice(cIdx, 1)[0];
                        if (typeof player_op.hand.addCard === 'function') player_op.hand.addCard(foundCard);
                        else opHandArr.push(foundCard);
                    }
                }
            }

            window.networkOpponentReadyForRound = true;
            if (window.resolveNetworkStartRound) {
                window.resolveNetworkStartRound();
                window.resolveNetworkStartRound = null;
            }
        }
        else if (data.type === 'PASS_TURN') {
            player_op.passRound(); 
        }
        else if (data.type === 'DECK_SYNC') {
            window.opponentDeckData = data.deck;
            if (window.myDeckData && !window.amIHost) {
                window.startMultiplayerMatch();
                connection.send({ type: 'GUEST_READY' });
            }
        }
        else if (data.type === 'GUEST_READY') {
            if (window.amIHost && !window.gameStarted) {
                window.gameStarted = true; 
                window.startMultiplayerMatch(); 
            }
        }
        else if (data.type === 'TURN_ACTION_V2') {
            window.blockNetworkBroadcast = true; 
            window.isReceivingNetworkCards = true; 
            window.networkCarouselChoices = data.carouselChoices || [];

            console.log("NETWORK: Incoming Turn Payload:", data);

            const executeTurn = async () => {
                if (data.isLeader && typeof player_op.activateLeader === 'function') {
                    try { await player_op.activateLeader(); } catch(e) {}
                }

                if (data.primaryCard) {
                    let opHandArr = player_op.hand.cards || player_op.hand;
                    let cardToPlayIndex = opHandArr.findIndex(c => window.matchCard(c, data.primaryCard));
                    
                    if (cardToPlayIndex !== -1) {
                        let cardToPlay = opHandArr[cardToPlayIndex];

                        // --- DECOY (MANNEKIN) INTERCEPTOR ---
                        let isDecoy = (cardToPlay.name === "Decoy" || cardToPlay.id === "decoy" || (cardToPlay.abilities && cardToPlay.abilities.includes("decoy")));
                        if (isDecoy && data.addedCards && data.addedCards.length > 0) {
                            let targetData = data.addedCards[0];
                            let targetCardObj = null;
                            let targetRow = null;
                            
                            for (let row of board.row) {
                                let found = row.cards.find(c => window.matchCard(c, targetData) && c.holder === player_op);
                                if (found) {
                                    targetCardObj = found;
                                    targetRow = row;
                                    break;
                                }
                            }
                            
                            if (targetCardObj && targetRow) {
                                try {
                                    if (typeof board.toHand === 'function') {
                                        await board.toHand(targetCardObj, targetRow);
                                    } else {
                                        targetRow.removeCard(targetCardObj);
                                        opHandArr.push(targetCardObj);
                                    }
                                    
                                    if (typeof player_op.playCardToRow === 'function') {
                                        await player_op.playCardToRow(cardToPlay, targetRow);
                                    } else {
                                        targetRow.addCard(cardToPlay);
                                        if (typeof player_op.hand.removeCard === 'function') player_op.hand.removeCard(cardToPlay);
                                        else opHandArr.splice(cardToPlayIndex, 1);
                                    }
                                } catch (err) {}
                            } 
                            
                            window.blockNetworkBroadcast = false;
                            window.isReceivingNetworkCards = false;
                            window.networkCarouselChoices = [];
                            return; 
                        }

                        // --- NORMAL CARD EXECUTION ---
                        let origDraw = player_op.deck.draw;
                        if (data.addedCards && data.addedCards.length > 0) {
                            player_op.deck.draw = async function(hand, ...args) {
                                let targetData = data.addedCards.shift();
                                if (targetData) {
                                    let deckArr = this.cards || this.deck || this;
                                    let cIdx = deckArr.findIndex(c => window.matchCard(c, targetData));
                                    if (cIdx !== -1) {
                                        let c = deckArr.splice(cIdx, 1)[0];
                                        deckArr.unshift(c); 
                                    }
                                }
                                return await origDraw.apply(this, [hand, ...args]);
                            };
                        }

                        try { 
                            let targetRow = null;
                            // Map the Sender's row index to the Receiver's perspective
                            if (data.targetRowIndex !== undefined && data.targetRowIndex !== null && data.targetRowIndex >= 0 && data.targetRowIndex < 6) {
                                let mappedIndex = (data.targetRowIndex + 3) % 6;
                                targetRow = board.row[mappedIndex];
                            }

                            if (targetRow && typeof player_op.playCardToRow === 'function') {
                                console.log("NETWORK: Agile/Targeted card detected. Forcing to row index:", board.row.indexOf(targetRow));
                                await player_op.playCardToRow(cardToPlay, targetRow);
                            } else {
                                await player_op.playCard(cardToPlay); 
                            }
                        } catch (err) {
                            console.error("NETWORK: Engine error during opponent card play!", err);
                        }
                        player_op.deck.draw = origDraw; 
                    } else {
                        console.error("NETWORK DESYNC CRASH: Could not find card in opponent's hand!", data.primaryCard);
                    }
                }

                window.blockNetworkBroadcast = false;
                window.isReceivingNetworkCards = false;
                window.networkCarouselChoices = [];
            };
            executeTurn();
        }
        else if (data.type === 'COIN_TOSS_TRUTH') {
            window.networkHostStarts = data.hostStarts;
            if (window.resolveCoinTruth) {
                window.resolveCoinTruth();
                window.resolveCoinTruth = null;
            }
        }
        else if (data.type === 'GAME_START_SYNC') {
            const drawMatchedHands = async () => {
                const origDraw = player_me.deck.draw;
                const syncDraw = async function(hand, targetIndexList) {
                    let target = targetIndexList.shift();
                    let deckArr = this.cards || this.deck || this;
                    
                    let tId = typeof target === 'object' ? (target.id || target.name || target.index) : target;
                    let tName = typeof target === 'object' ? target.name : target;

                    let cIdx = deckArr.findIndex(c => 
                        String(c.index) === String(tId) || 
                        String(c.id) === String(tId) || 
                        String(c.name) === String(tId) ||
                        (tName && String(c.name) === String(tName))
                    );

                    if (cIdx !== -1) {
                        let origRandom = Math.random;
                        Math.random = () => 0; 
                        let card = deckArr.splice(cIdx, 1)[0];
                        deckArr.unshift(card); 
                        await origDraw.call(this, hand);
                        Math.random = origRandom; 
                    } else {
                        await origDraw.call(this, hand); 
                    }
                };

                player_me.deck.draw = syncDraw;
                player_op.deck.draw = syncDraw;

                let opTargets = [...data.opHandIndices];
                let myTargets = [...data.myHandIndices];

                for(let i=0; i<10; i++) {
                    await player_me.deck.draw(player_me.hand, opTargets);
                    await player_op.deck.draw(player_op.hand, myTargets);
                }

                player_me.deck.draw = origDraw;
                player_op.deck.draw = origDraw;

                if (typeof window.resolveGameSync === 'function') {
                    window.resolveGameSync();
                    window.resolveGameSync = null;
                }
            };
            drawMatchedHands();
        }
    });
}

window.initPeer();