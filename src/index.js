import {Bond, TimeBond, TransformBond as oo7TransformBond, ReactivePromise} from 'oo7';
import BigNumber from 'bignumber.js';
import {abiPolyfill} from './abis.js';

export function setupBonds(_api = parity.api) {
	console.log("setupBonds...");
	_api.parity.netChain().then(c => console.log(`setupBonds: on chain ${c}`));
	console.log('Kill subscriptions');

	let api = _api;
	var bonds = {};

	api.util.abiSig = function (name, inputs) {
		return api.util.sha3(`${name}(${inputs.join()})`);
	};

	api.util.cleanup = function (value, type) {
		// TODO: make work with arbitrary depth arrays
		if (value instanceof Array && type.match(/bytes[0-9]+/)) {
			// figure out if it's an ASCII string hiding in there:
			var ascii = '';
			for (var i = 0, ended = false; i < value.length && ascii !== null; ++i) {
				if (value[i] === 0) {
					ended = true;
				} else {
					ascii += String.fromCharCode(value[i]);
				}
				if ((ended && value[i] !== 0) || (!ended && (value[i] < 32 || value[i] >= 128))) {
					ascii = null;
				}
			}
			value = ascii === null ? api.util.bytesToHex(value) : ascii;
		}
		if (type.substr(0, 4) == 'uint' && +type.substr(4) <= 48) {
			value = +value;
		}
		return value;
	}

	// returns [functionName, argsByName]
	api.util.abiUnencode = function (abi, data) {
		let s = data.substr(2, 8);
		let op = abi.find(f =>
			f.type == 'function' &&
			api.util.abiSig(f.name, f.inputs.map(i => i.type))
				.substr(2, 8) === s
		);
		if (!op) {
			console.warn(`Unknown function ID: ${s}`);
			return null;
		}
		let argsByIndex = api.util.abiDecode(
				op.inputs.map(f => f.type), '0x' + data.substr(10)
			).map((v, i) => api.util.cleanup(v, op.inputs[i].type));
		let argsByName = {};
		op.inputs.forEach((f, i) => {
			argsByName[f.name] = argsByIndex[i];
		});
		return [op.name, argsByName, argsByIndex];
	}

	class TransformBond extends oo7TransformBond {
		constructor (f, a = [], d = [], latched = true, mayBeNull = false) {
			super(f, a, d, latched, mayBeNull, api);
		}
		map (f) {
	        return new TransformBond(f, [this]);
	    }
		sub (name) {
			return new TransformBond((r, n) => r[n], [this, name]);
		}
		static all(list) {
			return new TransformBond((...args) => args, list);
		}
	}

	// TODO: Use more generic means to check on number, ideally push notification.
	class SubscriptionBond extends Bond {
		constructor(rpc) {
			super();
			this.rpc = rpc;
		}
		initialise () {
			api.subscribe(this.rpc, (_, n) => this.trigger(n))
				.then(id => this.subscription = id);
		}
		finalise () {
			api.unsubscribe(this.subscription);
		}
		map (f) {
	        return new TransformBond(f, [this]);
	    }
		sub (name) {
			return new TransformBond((r, n) => r[n], [this, name]);
		}
		static all(list) {
			return new TransformBond((...args) => args, list);
		}
	}

	class Signature extends ReactivePromise {
		constructor(from, message) {
			super([from, message], [], ([from, message]) => {
				api.parity.postSign(from, api.util.asciiToHex(message))
					.then(signerRequestId => {
						this.trigger({requested: signerRequestId});
				    	return api.pollMethod('parity_checkRequest', signerRequestId);
				    })
				    .then(signature => {
						this.trigger({signed: signature});
					})
					.catch(error => {
						this.trigger({failed: error});
					});
			});
		}
	}

	class Transaction extends ReactivePromise {
		constructor(tx) {
			super([tx], [], ([tx]) => {
				let progress = this.trigger.bind(this);
				progress({estimating: null});
				let from = tx.from || bonds.defaultAccount;
				let gasPrice = tx.gasPrice || bonds.gasPrice;
				let gas = tx.gas || bonds.estimateGas({
					value: tx.value,
					from: tx.from || bonds.defaultAccount,
					to: tx.to,
					gasPrice: tx.gasPrice || bonds.gasPrice,
					data: tx.data
				});

				this.internal = new ReactivePromise([from, gasPrice, gas], [], ([from, gasPrice, gas]) => {
					console.log(`Finally posting ${JSON.stringify(tx)} with gas: ${gas}, gasPrice: ${gasPrice}, from: ${from}`);
					tx.gas = gas;
					tx.gasPrice = gasPrice;
					tx.from = from;
					api.parity.postTransaction(tx)
						.then(signerRequestId => {
							progress({requested: signerRequestId});
					    	return api.pollMethod('parity_checkRequest', signerRequestId);
					    })
					    .then(transactionHash => {
							progress({signed: transactionHash});
							return api.pollMethod('eth_getTransactionReceipt', transactionHash, (receipt) => receipt && receipt.blockNumber && !receipt.blockNumber.eq(0));
						})
						.then(receipt => {
							progress({confirmed: receipt});
						})
						.catch(error => {
							progress({failed: error});
						});
				}).use();
			});
		}
		finalise () {
			this.internal.drop();
			ReactivePromise.finalise(this);
		}
	}

	function overlay(base, top) {
		Object.keys(top).forEach(k => {
			base[k] = top[k];
		});
		return base;
	}

	function memoized(f) {
		var memo;
		return function() {
			if (memo === undefined)
				memo = f();
			return memo;
		};
	}

	function call(addr, method, args, options) {
		let data = api.util.abiEncode(method.name, method.inputs.map(f => f.type), args);
		let decode = d => api.util.abiDecode(method.outputs.map(f => f.type), d);
		return api.eth.call(overlay({to: addr, data: data}, options)).then(decode);
	};

	function post(addr, method, args, options) {
		let toOptions = (addr, method, options, ...args) => {
			return overlay({to: addr, data: api.util.abiEncode(method.name, method.inputs.map(f => f.type), args)}, options);
		};
		return new bonds.Transaction(toOptions.bond(addr, method, options, ...args));
	};

	bonds.Transaction = Transaction;
	bonds.Signature = Signature;
	bonds.Subscription = SubscriptionBond;
	bonds.Transform = TransformBond;
    bonds.time = new TimeBond;
	bonds.blockNumber = new TransformBond(() => api.eth.blockNumber().then(_=>+_), [], [bonds.time]);
//	bonds.blockNumber = new TransformBond(_=>+_, [new SubscriptionBond('eth_blockNumber')]);
//	bonds.accounts = new SubscriptionBond('eth_accounts').subscriptable();
//	bonds.accountsInfo = new SubscriptionBond('parity_accountsInfo').subscriptable();
//	bonds.defaultAccount = new SubscriptionBond('parity_defaultAccount').subscriptable();
//	bonds.allAccountsInfo = new SubscriptionBond('parity_allAccountsInfo');
//	bonds.requestsToConfirm = new SubscriptionBond('signer_requestsToConfirm');

	Function.__proto__.bond = function(...args) { return new TransformBond(this, args); };
	Function.__proto__.unlatchedBond = function(...args) { return new TransformBond(this, args, [], false, undefined); };
    Function.__proto__.timeBond = function(...args) { return new TransformBond(this, args, [bonds.time]); };
    Function.__proto__.blockBond = function(...args) { return new TransformBond(this, args, [bonds.blockNumber]); };

	let presub = function (f) {
		return new Proxy(f, {
			get (receiver, name) {
				if (typeof(name) === 'string' || typeof(name) === 'number') {
					return typeof(receiver[name]) !== 'undefined' ? receiver[name] : receiver(name);
				} else if (typeof(name) === 'symbol' && Bond.knowSymbol(name)) {
					return receiver(Bond.fromSymbol(name));
				} else {
					throw `Weird value type to be subscripted by: ${typeof(name)}: ${JSON.stringify(name)}`;
				}
			}
		});
	};

	// eth_
	bonds.blockByNumber = (x => new TransformBond(api.eth.getBlockByNumber, [x], []).subscriptable());// TODO: chain reorg that includes number x
	bonds.blockByHash = (x => new TransformBond(api.eth.getBlockByHash, [x]).subscriptable());
	bonds.blockByX = (x => new TransformBond(n => typeof(n) === 'number' || (typeof(n) === 'string' && n.match(/^[0-9]+$/)) ? api.eth.getBlockByNumber(x) : api.eth.getBlockByHash(x), [x], []).subscriptable());// TODO: chain reorg that includes number x, if x is a number
	bonds.blocks = presub(bonds.blockByX);
	bonds.block = bonds.blockByNumber(bonds.blockNumber);
	bonds.coinbase = new TransformBond(api.eth.coinbase, [], [bonds.time]);
	bonds.accounts = new TransformBond(a => a.map(api.util.toChecksumAddress), [new TransformBond(api.eth.accounts, [], [bonds.time])]).subscriptable();
	bonds.defaultAccount = bonds.accounts[0];	// TODO: make this use its subscription
	bonds.me = bonds.accounts[0];

	bonds.balance = (x => new TransformBond(api.eth.getBalance, [x], [bonds.blockNumber]));
	bonds.code = (x => new TransformBond(api.eth.getCode, [x], [bonds.blockNumber]));
	bonds.transactionCount = (x => new TransformBond(api.eth.getTransactionCount, [x], [bonds.blockNumber]));
	bonds.storageAt = ((x, y) => new TransformBond(api.eth.getStorageAt, [x, y], [bonds.blockNumber]));

	bonds.syncing = new TransformBond(api.eth.syncing, [], [bonds.time]);
	bonds.hashrate = new TransformBond(api.eth.hashrate, [], [bonds.time]);
	bonds.mining = new TransformBond(api.eth.mining, [], [bonds.time]);
	bonds.protocolVersion = new TransformBond(api.eth.protocolVersion, [], [bonds.time]);
	bonds.gasPrice = new TransformBond(api.eth.gasPrice, [], [bonds.time]);
	bonds.estimateGas = (x => new TransformBond(api.eth.estimateGas, [x], [bonds.blockNumber]));

	// Weird compound

	// net_
    bonds.peerCount = new TransformBond(api.net.peerCount, [], [bonds.time]);

	// parity_
	bonds.hashContent = u => new TransformBond(api.parity.hashContent, [u], [], false);
	bonds.netChain = new TransformBond(api.parity.netChain, [], [bonds.time]);
	bonds.accountsInfo = new TransformBond(api.parity.accountsInfo, [], [bonds.time]).subscriptable(2); //new SubscriptionBond('parity_accountsInfo');

	bonds.makeContract = function(address, abi, extras = []) {
		var r = { address: address };
		let unwrapIfOne = a => a.length == 1 ? a[0] : a;
		abi.forEach(i => {
			if (i.type == 'function' && i.constant) {
				let f = function (...args) {
					var options = args.length === i.inputs.length + 1 ? args.unshift() : {};
					if (args.length != i.inputs.length)
						throw `Invalid number of arguments to ${i.name}. Expected ${i.inputs.length}, got ${args.length}.`;
					let f = (addr, ...fargs) => call(addr, i, fargs, options).then(unwrapIfOne);
					return new TransformBond(f, [address, ...args], [bonds.blockNumber]).subscriptable();	// TODO: should be subscription on contract events
				};
				r[i.name] = (i.inputs.length === 0) ? memoized(f) : (i.inputs.length === 1) ? presub(f) : f;
			}
		});
		extras.forEach(i => {
			let f = function (...args) {
				let expectedInputs = (i.numInputs || i.args.length);
				var options = args.length === expectedInputs + 1 ? args.unshift() : {};
				if (args.length != expectedInputs)
					throw `Invalid number of arguments to ${i.name}. Expected ${expectedInputs}, got ${args.length}.`;
				let c = abi.find(j => j.name == i.method);
				let f = (addr, ...fargs) => {
					let args = i.args.map((v, index) => v === null ? fargs[index] : typeof(v) === 'function' ? v(fargs[index]) : v);
					return call(addr, c, args, options).then(unwrapIfOne);
				};
				return new TransformBond(f, [address, ...args], [bonds.blockNumber]).subscriptable();	// TODO: should be subscription on contract events
			};
			r[i.name] = (i.args.length === 1) ? presub(f) : f;
		});
		abi.forEach(i => {
			if (i.type == 'function' && !i.constant) {
				r[i.name] = function (...args) {
					var options = args.length === i.inputs.length + 1 ? args.pop() : {};
					if (args.length !== i.inputs.length)
						throw `Invalid number of arguments to ${i.name}. Expected ${i.inputs.length}, got ${args.length}.`;
					return post(address, i, args, options).subscriptable();
				};
			}
		});
		var eventLookup = {};
		abi.filter(i => i.type == 'event').forEach(i => {
			eventLookup[api.util.abiSig(i.name, i.inputs.map(f => f.type))] = i.name;
		});

		abi.forEach(i => {
			if (i.type == 'event') {
				r[i.name] = function (indexed = {}, params = {}) {
					return new TransformBond((addr, indexed) => {
						var topics = [api.util.abiSig(i.name, i.inputs.map(f => f.type))];
						i.inputs.filter(f => f.indexed).forEach(f => {
							var val = null;
							if (indexed[f.name]) {
								if (f.type == 'string' || f.type == 'bytes') {
									val = api.util.sha3(indexed[f.name]);
								} else {
									val = api.util.abiEncode(null, [f.type], [indexed[f.name]]);
								}
								if (val.length != 66) {
									console.warn(`Couldn't encode indexed parameter ${f.name} of type ${f.type} with value ${indexed[f.name]}`);
									val = null;
								}
							}
							topics.push(val);
						});
						return api.eth.getLogs({
							address: addr,
							fromBlock: params.fromBlock || 0,
							toBlock: params.toBlock || 'pending',
							limit: params.limit || 10,
							topics: topics
						}).then(logs => logs.map(l => {
							l.blockNumber = +l.blockNumber;
							l.transactionIndex = +l.transactionIndex;
							l.logIndex = +l.logIndex;
							l.transactionLogIndex = +l.transactionLogIndex;
							var e = {};
							let unins = i.inputs.filter(f => !f.indexed);
							api.util.abiDecode(unins.map(f => f.type), l.data).forEach((v, j) => {
								let f = unins[j];
								if (v instanceof Array && !f.type.endsWith(']')) {
									v = api.util.bytesToHex(v);
								}
								if (f.type.substr(0, 4) == 'uint' && +f.type.substr(4) <= 48) {
									v = +v;
								}
								e[f.name] = v;
							});
							i.inputs.filter(f => f.indexed).forEach((f, j) => {
								if (f.type == 'string' || f.type == 'bytes') {
									l.args[f.name] = l.topics[1 + j];
								} else {
									var v = api.util.abiDecode([f.type], l.topics[1 + j])[0];
									if (v instanceof Array) {
										v = api.util.bytesToHex(v);
									}
									if (f.type.substr(0, 4) == 'uint' && +f.type.substr(4) <= 48) {
										v = +v;
									}
									e[f.name] = v;
								}
							});
							e.event = eventLookup[l.topics[0]];
							e.log = l;
							return e;
						}));
					}, [address, indexed], [bonds.blockNumber]).subscriptable();
				};
			}
		});
		return r;
	};

	bonds.registry = bonds.makeContract(new TransformBond(api.parity.registryAddress, [], [bonds.time]), api.abi.registry, api.abi.registryExtras);	// TODO should be subscription.
	bonds.githubhint = bonds.makeContract(bonds.registry.lookupAddress('githubhint', 'A'), api.abi.githubhint);
	bonds.operations = bonds.makeContract(bonds.registry.lookupAddress('operations', 'A'), api.abi.operations);

	return bonds;
}

////
// Parity Utilities

// TODO: move to parity.js, repackage or repot.

export function capitalizeFirstLetter(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export function singleton(f) {
    var instance = null;
    return function() {
        if (instance === null)
            instance = f();
        return instance;
    }
}

export const denominations = [ "wei", "Kwei", "Mwei", "Gwei", "szabo", "finney", "ether", "grand", "Mether", "Gether", "Tether", "Pether", "Eether", "Zether", "Yether", "Nether", "Dether", "Vether", "Uether" ];

export function denominationMultiplier(s) {
    let i = denominations.indexOf(s);
    if (i < 0)
        throw "Invalid denomination";
    return (new BigNumber(1000)).pow(i);
}

export function interpretQuantity(s) {
    try {
        let m = s.toLowerCase().match('([0-9,.]+) *([a-zA-Z]+)?');
        let d = denominationMultiplier(m[2] || 'ether');
        let n = +m[1].replace(',', '');
        while (n !== Math.round(n)) {
            n *= 10;
            d = d.div(10);
        }
        return new BigNumber(n).mul(d);
    }
    catch (e) {
        return null;
    }
}

export function splitValue(a) {
	var i = 0;
	var a = new BigNumber('' + a);
	if (a.gte(new BigNumber("10000000000000000")) && a.lt(new BigNumber("100000000000000000000000")) || a.eq(0))
		i = 6;
	else
		for (var aa = a; aa.gte(1000) && i < denominations.length - 1; aa = aa.div(1000))
			i++;

	for (var j = 0; j < i; ++j)
		a = a.div(1000);

	return {base: a, denom: i};
}

export function formatBalance(n) {
	let a = splitValue(n);
	let b = Math.floor(a.base * 1000) / 1000;
	return `${b} ${denominations[a.denom]}`;
}

export function formatBlockNumber(n) {
    return '#' + ('' + n).replace(/(\d)(?=(\d{3})+$)/g, "$1,");
}

export function isNullData(a) {
	return !a || typeof(a) !== 'string' || a.match(/^(0x)?0+$/) !== null;
}

export { abiPolyfill };
