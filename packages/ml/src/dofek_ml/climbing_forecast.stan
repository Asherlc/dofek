// Assigned-grade dynamic Bradley–Terry likelihood from Drummond and Popinga.
// Future states continue the observed monthly random walk without seeing holdout outcomes.
data {
  int<lower=1> month_count;
  int<lower=1> observation_count;
  array[observation_count] int<lower=1, upper=month_count> observation_month;
  vector[observation_count] climb_grade;
  array[observation_count] int<lower=0, upper=1> sent;
  real initial_grade;
}
parameters {
  real<lower=0> slope;
  vector[month_count] ability;
}
model {
  slope ~ lognormal(-0.5, 0.6);
  ability[1] ~ normal(initial_grade, 5);
  for (month in 2:month_count) {
    ability[month] ~ normal(ability[month - 1], 0.5);
  }
  sent ~ bernoulli_logit(slope * (ability[observation_month] - climb_grade));
}
