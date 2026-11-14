const fallbackPromos = new Map();

function getPromoForProduct(product) {
  if (!product) {
    return {
      is_promo_active: false,
      promo_price: null,
      effective_price: 0
    };
  }

  const pid = Number(product.id);
  const fb = fallbackPromos.get(pid);

  const isPromoActive = fb !== undefined ? Boolean(fb.is_promo_active) : Boolean(product.is_promo_active);
  const promoPrice = fb !== undefined
    ? (fb.promo_price !== null && fb.promo_price !== undefined ? Number(fb.promo_price) : null)
    : (product.promo_price !== null && product.promo_price !== undefined ? Number(product.promo_price) : null);

  const regularPrice = Number(product.price) || 0;
  const effectivePrice = isPromoActive && promoPrice !== null && promoPrice > 0
    ? Number(Number(promoPrice).toFixed(2))
    : Number(regularPrice.toFixed(2));

  return {
    is_promo_active: isPromoActive,
    promo_price: promoPrice,
    effective_price: effectivePrice
  };
}

function setPromoForProduct(productId, isPromoActive, promoPrice) {
  const pid = Number(productId);
  const parsedPrice = promoPrice !== null && promoPrice !== undefined && promoPrice !== ''
    ? Number(Number(promoPrice).toFixed(2))
    : null;

  fallbackPromos.set(pid, {
    is_promo_active: Boolean(isPromoActive),
    promo_price: parsedPrice
  });

  return {
    id: pid,
    is_promo_active: Boolean(isPromoActive),
    promo_price: parsedPrice
  };
}

function resetPromoStore() {
  fallbackPromos.clear();
}

module.exports = {
  fallbackPromos,
  getPromoForProduct,
  setPromoForProduct,
  resetPromoStore
};
